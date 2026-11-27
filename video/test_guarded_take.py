#!/usr/bin/env python3
"""Tests for guarded_take.run_guarded with a fake take and a fake lab (no docker, no browser). Run: python3 video/test_guarded_take.py"""
import sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import guarded_take as g

# A fake take: writes a marker into its work dir, then runs 30 s the first time (argv[2] holds a flag file) and 1 s every later time.
FAKE = ("import sys,time,pathlib; w=pathlib.Path(sys.argv[1]); w.mkdir(parents=True,exist_ok=True); (w/'take.log').write_text('x'); "
        "f=pathlib.Path(sys.argv[2]); first=not f.exists(); f.write_text('1'); time.sleep(30 if first else 1)")


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()); self.work = self.tmp / "take"; self.logs = []
        self.cmd = [sys.executable, "-c", FAKE, str(self.work), str(self.tmp / "flag")]

    def test_lab_vanishes_midtake_take_stopped_lab_restarted_partial_moved_and_retried(self):
        state = {"up_until": time.time() + 1.0, "starts": 0}
        def health(): return time.time() < state["up_until"]            # the lab disappears 1 s into the first attempt
        def start():
            state["starts"] += 1; state["up_until"] = time.time() + 1000; return True   # back, and stays up
        t0 = time.time()
        code = g.run_guarded(self.cmd, self.work, health=health, start=start, every=0.3, misses=2, log=self.logs.append)
        self.assertEqual(code, 0)
        self.assertLess(time.time() - t0, 15, "the 30 s first take must have been cut short")
        self.assertEqual(state["starts"], 1, "the lab must be brought back once")
        self.assertTrue((Path(str(self.work) + "-aborted-1") / "take.log").exists(), "the partial run must be moved aside")
        self.assertTrue((self.work / "take.log").exists(), "the kept take is the second one")
        self.assertTrue(any("went away" in m for m in self.logs))

    def test_healthy_lab_runs_once_and_keeps_the_take(self):
        (self.tmp / "flag").write_text("1")   # so the fake take is the short one
        code = g.run_guarded(self.cmd, self.work, health=lambda: True, start=lambda: self.fail("must not start a healthy lab"), every=0.2, log=self.logs.append)
        self.assertEqual(code, 0)
        self.assertFalse(Path(str(self.work) + "-aborted-1").exists())

    def test_lab_that_cannot_be_started_gives_up_with_3_and_runs_nothing(self):
        code = g.run_guarded(self.cmd, self.work, health=lambda: False, start=lambda: False, every=0.2, log=self.logs.append)
        self.assertEqual(code, 3)
        self.assertFalse(self.work.exists(), "no take may have run")

    def test_lab_lost_on_every_attempt_keeps_nothing_and_returns_4(self):
        st = {"t": time.time()}
        def health(): return time.time() - st["t"] < 1.0
        def start(): st["t"] = time.time(); return True
        (self.tmp / "flag").unlink(missing_ok=True)
        # every attempt: the lab drops 1 s in; make the fake take long every time by clearing the flag between attempts
        import os
        flag = self.tmp / "flag"; orig_start = start
        def start2(): flag.unlink(missing_ok=True); return orig_start()
        code = g.run_guarded(self.cmd, self.work, health=health, start=start2, max_attempts=2, every=0.3, misses=2, log=self.logs.append)
        self.assertEqual(code, 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
