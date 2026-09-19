;; tools/create-asset.wat — the one tool's logic, hand-written, ~15 instructions.
;;
;; WHY IT IS WASM AND NOT JS (§1.8): a JS tool in a worker keeps ambient `fetch`, so the
;; "network" row would be a promise about the tool's behaviour. A WebAssembly module has no
;; globals, no ambient scope and no way to name anything the host did not hand it: its entire
;; interface is the two imports below. That is what makes the network row STRUCTURAL — the
;; mechanism itself is missing, rather than denied by a policy that someone could edit.
;;
;; THE ARGUMENT RECORD (and one honest divergence from the build spec, §6):
;;   The spec writes the export as `run(argsJson)`. Parsing JSON inside Wasm means writing a JSON
;;   parser in WAT, which is not a 30-line module — so the host does the schema validation, the
;;   containment resolve and the tier decision, and then lays the VALIDATED fields in linear memory
;;   as integers and passes their location:
;;
;;     args+0  u32  path_ptr      args+4  u32  path_len
;;     args+8  u32  body_ptr      args+12 u32  body_len
;;
;;   The module's job is then exactly what a tool's job is here: hand the bytes to the host and
;;   have the host resolve, decide and write. Nothing is lost — the enforcement all happens in
;;   `writeFile`, which re-resolves the path it is handed — and the module stays small enough to
;;   read in one sitting. The signature keeps the spec's shape (two i32 params, void return).

(module
  ;; Exactly two imports. No fetch, no import, no eval — not denied: never handed over.
  (import "env" "writeFile"
    (func $write_file (param i32 i32 i32 i32)))   ;; path_ptr path_len data_ptr data_len
  (import "env" "note"
    (func $note (param i32 i32)))                 ;; msg_ptr msg_len

  (memory (export "memory") 1)

  (data (i32.const 512) "create-asset: writing")

  ;; run(args_ptr, args_len) -> void
  (func (export "run") (param $args i32) (param $args_len i32)
    (call $note (i32.const 512) (i32.const 21))
    (call $write_file
      (i32.load offset=0  (local.get $args))
      (i32.load offset=4  (local.get $args))
      (i32.load offset=8  (local.get $args))
      (i32.load offset=12 (local.get $args))))
)
