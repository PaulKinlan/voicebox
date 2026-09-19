;; tests/fixtures/trap.wat — check 7: a module that traps must not take the host with it.
;; A trapping tool is the browser's version of a crashed subprocess: the turn fails, the host
;; records what was attempted, and the next turn is served.
(module
  (memory (export "memory") 1)
  (func (export "run") (param $a i32) (param $b i32)
    (unreachable)))
