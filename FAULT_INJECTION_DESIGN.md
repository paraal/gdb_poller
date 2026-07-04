# Fault Injection and Stuck-At Design Notes

This note describes a possible future feature for GDB Live Watch: forcing a variable to a chosen value in a running target without changing source code or rebuilding the software.

The important distinction is between three levels of injection:

1. One-shot write: write a value once through the debugger.
2. Best-effort stuck-at: repeatedly write the value from the extension while the target runs.
3. Real stuck-at: change the target's runtime execution so every relevant software cycle produces or restores the forced value at native speed.

The existing extension already supports the first level through Set Value. The second level would be easy to add, but it cannot meet a strict real-time requirement. The third level is possible, but it is a larger, architecture-specific feature that would use GDB raw memory access, disassembly, and inferior-call primitives instead of only DAP evaluate/setVariable calls.

## Requirement

The desired behavior is:

- Choose a variable or expression from Live Watch, Symbols, or DAQ.
- Choose a forced value, for example `0`, `1`, `42`, or a floating-point value.
- Apply the injection to the already-running software.
- The software should see that variable as stuck at the chosen value every cycle.
- No source modification, no rebuild, and ideally no repeated debugger pause/resume activity.
- Stopping the injection should restore normal execution.

The key constraint is timing. If the extension periodically pauses the target and writes the variable, the target can run between writes and may observe the non-forced value. That also adds jitter and can disturb VEOS or other timing-sensitive systems. For real stuck-at behavior, the forced assignment must execute as part of the target's own code path.

## Why Polling-Based Injection Is Not Enough

A simple implementation would store a list of pinned variables and write them on every poll tick:

```text
pause target
set var variable = forcedValue
continue target
```

Or, in non-stop mode:

```text
-gdb-set var variable = forcedValue
```

This is useful for slow signals, manual experiments, and non-real-time debugging. It is not a real stuck-at mechanism because:

- the target can overwrite the variable immediately after the debugger write;
- the target can read the original value before the next injection tick;
- pause/write/continue cycles add latency and jitter;
- faster polling makes the target slower and less representative;
- native Windows GDB attach already has known pause-related fragility in this extension.

So this should be treated as "best-effort pinning", not true fault injection.

## Middle Ground: Watchpoint With Auto-Commands

GDB can stop when a watched memory location is written and then run commands automatically:

```gdb
watch variable
commands
  silent
  set var variable = forcedValue
  continue
end
```

If hardware watchpoints are available, the target runs at native speed until the write happens. That avoids periodic polling. However, every actual write still traps into the debugger, executes GDB commands, and resumes. For a high-rate control-loop variable, this can still add significant timing disturbance.

This approach is useful when:

- writes are infrequent;
- a small amount of timing disturbance is acceptable;
- the target/debug adapter supports reliable hardware watchpoints;
- the user wants an easier implementation before full binary patching.

It is not ideal for a variable written every model cycle if the requirement is no observable slowdown.

## Real Stuck-At: Runtime Code Patching

The strongest approach is to patch the target's machine code while it is loaded. Instead of asking GDB to keep writing the variable, the extension modifies the instruction stream so the forced value is written by the target itself.

The runtime sequence would be:

1. Resolve the variable address and type.
2. Discover the instruction or instructions that write the variable.
3. Stop the target once at a controlled point.
4. Save the original instruction bytes.
5. Allocate or find executable scratch space for a small trampoline.
6. Write patch code into the scratch space.
7. Replace the original write-site bytes with a jump to the patch code.
8. Resume the target.
9. While active, the target executes the forced assignment itself at native speed.
10. On disable, restore the original bytes and remove any helper state.

Conceptually:

```text
original code:
  compute value
  store value -> variable
  continue model cycle

patched code:
  compute value
  jump patch_trampoline

patch_trampoline:
  optionally execute original overwritten instruction(s)
  store forcedValue -> variable
  jump back after patched instruction(s)
```

This is the only option in this list that can behave like a true stuck-at fault with near-zero runtime overhead after installation.

## GDB Capabilities Needed

This feature would need capabilities below the current extension's normal DAP read/write layer.

Useful GDB operations include:

```gdb
p &variable
ptype variable
x/16xb ADDRESS
x/8i ADDRESS
disassemble FUNCTION
set {unsigned char}ADDRESS = 0xNN
set {int}ADDRESS = 123
call malloc(SIZE)
call VirtualAlloc(0, SIZE, 0x3000, 0x40)
call mprotect(PAGE, SIZE, PROT_READ|PROT_WRITE|PROT_EXEC)
```

The exact commands depend on platform, architecture, debug adapter, and whether the target is local, remote, or attached through a simulator/gdbserver.

The extension would likely need a small internal GDB-command layer, separate from normal DAP `evaluate`, because DAP does not expose every low-level primitive cleanly. With `cppdbg`, this may mean using `customRequest` calls that pass MI commands through to GDB, where supported.

## Discovering Write Sites

The hardest part is identifying where to patch.

Possible strategies:

### User-selected patch location

The user selects a source line, function, or symbol where the forced assignment should happen, for example the top of a control-loop function. The extension inserts a patch there that writes the forced value once per cycle.

This is practical for model code because users often know the cyclic entry point.

Advantages:

- deterministic;
- easier to explain;
- avoids needing to find every variable writer;
- good for "force this signal every cycle" use cases.

Disadvantages:

- requires user knowledge;
- if the selected point runs before later code overwrites the variable, the injection may not hold for the whole cycle.

### One-time watchpoint discovery

The extension sets a temporary watchpoint on the variable, lets the target run until the variable is written, records the program counter, then removes the watchpoint. That gives a candidate write instruction for patching.

Advantages:

- discovers real writers dynamically;
- does not need source-level knowledge;
- useful when the write site is generated code.

Disadvantages:

- only finds writers that execute during discovery;
- multiple writers require repeated discovery;
- watchpoint setup itself can disturb timing during the discovery phase.

### Static disassembly search

The extension disassembles relevant functions and searches for stores to the variable address or nearby memory.

Advantages:

- no target execution needed;
- can find multiple stores.

Disadvantages:

- architecture-specific;
- difficult with optimized code, register-indirect addressing, and pointer aliases;
- risky without a proper disassembler library.

A practical first version should probably support user-selected cycle locations and optional one-time watchpoint discovery, not full static analysis.

## Patch Installation Model

A conservative installation flow would be:

1. Require the target to be stopped or briefly pause it once.
2. Resolve expression to address and size.
3. Ask the user to choose an injection mode:
   - cycle-entry assignment;
   - patch discovered write site;
   - watchpoint auto-command fallback.
4. Validate architecture and pointer size.
5. Read and save original bytes from patch site.
6. Generate a patch plan but do not write yet.
7. Verify jump distance, instruction boundaries, and page permissions.
8. Write trampoline bytes.
9. Write jump bytes last, so the patch is either inactive or complete.
10. Resume target.

Disable flow:

1. Pause target.
2. Restore original bytes at patch site.
3. Optionally clear or free trampoline memory.
4. Resume target.
5. Mark injection inactive in the UI.

If restore fails, the extension should leave the target stopped and show the exact restore instructions and saved bytes.

## Architecture-Specific Work

Runtime code patching is not one feature. It is a family of small patchers, one per architecture and ABI.

For x86/x64:

- instructions have variable length;
- a 5-byte relative jump may not reach the trampoline;
- a longer absolute jump sequence may need more bytes;
- overwritten instructions must be decoded correctly;
- RIP-relative addressing needs relocation if moved into a trampoline;
- floating-point and vector values require correct immediate encoding or memory literal storage.

For ARM/AArch64:

- instructions are fixed-width but alignment matters;
- branch ranges may be limited;
- Thumb mode matters on 32-bit ARM;
- literal pools and PC-relative loads need care;
- instruction cache flush may be required after code writes.

For embedded or simulator targets:

- code may live in flash or read-only mapped memory;
- gdbserver may reject writes to text memory;
- there may be no allocator available in the inferior;
- memory maps may need to be inspected before choosing a code cave.

Because of this, the first supported target should be explicit, for example:

- Windows x86_64 process attached by `cppdbg` and MinGW GDB;
- VEOS host process where text memory can be patched through GDB;
- primitive scalar variables only: integer, boolean, float, double.

## Safety Checks

This feature should be opt-in and visibly armed because it intentionally changes executing code.

Recommended checks:

- Only enable for an active debug session.
- Require explicit confirmation before first patching a session.
- Show target architecture, variable address, patch site, and forced value.
- Save original bytes before writing anything.
- Verify original bytes still match before restoring.
- Refuse to patch if instruction decoding is uncertain.
- Refuse to patch if jump/trampoline range is invalid.
- Refuse to patch optimized or ambiguous expressions unless the user selects an address explicitly.
- Keep an emergency "Restore All Fault Injections" command.
- Automatically restore patches on debug session termination when possible.
- Store active injection state in memory only, not as persistent workspace state.

The extension should also make clear that this is intended for owned or authorized debug targets only.

## UI Shape

A possible UI model:

- Right-click Live Watch or Symbol item: `Inject Fault...`
- Dialog fields:
  - forced value;
  - mode: `Watchpoint`, `Cycle Assignment`, `Patch Write Site`;
  - optional cycle function or source location;
  - duration: until disabled, until next stop, or one session only.
- Active injections view:
  - variable/expression;
  - forced value;
  - mode;
  - patch site or watchpoint number;
  - status: armed, failed, restored;
  - actions: disable, restore, inspect GDB commands.

The UI should avoid presenting code patching as a normal Set Value operation. It is a different risk level.

## Suggested Implementation Phases

### Phase 1: Explicit GDB command bridge

Add a small internal service that can run raw GDB/MI commands through the active debug adapter and return structured results where possible. This is useful for more than fault injection and can be tested independently.

### Phase 2: Watchpoint fallback injection

Implement hardware/software watchpoint injection with auto-commands. This validates the UX and session lifecycle without writing text memory.

### Phase 3: Cycle-entry assignment patch

Support one controlled patch mode where the user chooses a function or source line that runs once per cycle. Generate a small architecture-specific assignment patch there.

This avoids discovering arbitrary write sites and is likely the most useful first true stuck-at mode for generated model code.

### Phase 4: One-time write-site discovery

Use temporary watchpoints to find actual writers, then patch those locations. Support multiple discovered write sites only after single-site restore is reliable.

### Phase 5: Broader type and architecture support

Add more scalar types, arrays/struct members, additional architectures, instruction relocation, and remote target memory-map handling.

## Recommendation

Do not implement this as faster polling. That cannot meet the requirement.

The best technical path is:

1. Start with a GDB command bridge.
2. Add watchpoint auto-command injection as a transparent fallback and proof of UX.
3. Build true stuck-at around runtime code patching for one explicitly supported target architecture first.
4. Prefer user-selected cycle-entry patching before trying to automatically discover and patch every write site.

This keeps the first version realistic while preserving the path to real zero-overhead fault injection.
