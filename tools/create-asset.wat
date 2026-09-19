(module
  ;; imports: the host hands the tool exactly two capabilities.
  ;; No fetch, no import, no eval — the host never provides them.
  (import "env" "writeFile"
    (func $write_file (param i32 i32 i32 i32)))  ;; path_ptr path_len data_ptr data_len
  (import "env" "note"
    (func $note (param i32 i32)))                 ;; msg_ptr msg_len

  ;; Linear memory: the module's own data and the asset body.
  (memory (export "memory") 1)

  ;; The asset body, pre-loaded by the host before run() is called.
  ;; The host writes [name_ptr, name_len, body_ptr, body_len] at offset 1024.
  ;; run() reads those four i32s and calls write_file.

  ;; run(args_json_ptr: i32, args_json_len: i32) -> void
  ;; The host calls this after schema validation and containment.
  ;; The module's logic: copy the body into the output, call note, call write_file.
  (func (export "run") (param $args_ptr i32) (param $args_len i32)
    ;; For M0 the host pre-places the file bytes in linear memory at a known
    ;; offset and passes their location via args_json. The module calls
    ;; write_file with those bytes. The logic is deliberately trivial —
    ;; the point is the boundary, not the computation.
    (i32.store (i32.const 64) (local.get $args_ptr))
    (i32.store (i32.const 68) (local.get $args_len))
    ;; note("creating asset")
    (call $note (i32.const 200) (i32.const 15))
    ;; write_file(path_ptr, path_len, data_ptr, data_len) — the host resolves
    ;; the path inside the root and writes the bytes.
    (call $write_file
      (i32.load (i32.const 64))    ;; path_ptr
      (i32.load (i32.const 68))    ;; path_len
      (i32.load (i32.const 72))    ;; data_ptr
      (i32.load (i32.const 76)))   ;; data_len
  )

  ;; The asset body as data segments, embedded at build time by the host.
  ;; M0: the host writes [name, body] into linear memory before run().
  (data (i32.const 200) "creating asset\00"))
