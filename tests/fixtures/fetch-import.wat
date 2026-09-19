;; tests/fixtures/fetch-import.wat — check 5's negative control.
;;
;; It is the smallest module that can only work if the host hands over a network capability.
;; The host does not: its import object is literally `{ env: { writeFile, note } }`. So this
;; module must fail to instantiate — and the failure must come from the platform's linker, not
;; from a policy check of ours, because a policy check is the thing we are trying to avoid
;; needing here.
(module
  (import "env" "fetch" (func $fetch (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (param $a i32) (param $b i32)
    (drop (call $fetch (i32.const 0)))))
