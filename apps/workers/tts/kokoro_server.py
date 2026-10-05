"""Local text-to-speech for the podcast prototype: Kokoro-82M through kokoro-onnx.

A long-lived process driven by the workers (apps/workers/src/podcast/kokoro.ts),
so the model loads once. One JSON request per stdin line:

    {"id": "1", "text": "Hello.", "voice": "af_heart", "speed": 1.0, "lang": "en-us", "out": "/tmp/x.wav"}

and one JSON reply per stdout line, after the clip is written to `out` as a
16-bit mono WAV:

    {"id": "1", "ok": true, "samples": 36000, "sampleRate": 24000, "ms": 412}

The first line printed is {"ready": true, ...}. Logs go to stderr.
"""

import json
import os
import sys
import time

import numpy as np
import onnxruntime as rt
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(HERE, "models", "kokoro-v1.0.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(HERE, "models", "voices-v1.0.bin"))


def reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def session() -> rt.InferenceSession:
    """CPU inference with a bounded thread pool and no spin-waiting.

    onnxruntime's default (a thread per core, spinning between ops) is fastest
    on an idle machine but collapses when other work shares the CPU: an
    episode took ~40x longer next to a busy dev environment. KOKORO_THREADS
    overrides the default of half the cores, at most 6.
    """
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("KOKORO_THREADS", min(6, max(1, (os.cpu_count() or 2) // 2))))
    opts.inter_op_num_threads = 1
    opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return rt.InferenceSession(MODEL, sess_options=opts, providers=["CPUExecutionProvider"])


def main() -> None:
    started = time.time()
    kokoro = Kokoro.from_session(session(), VOICES)
    print(f"kokoro loaded in {time.time() - started:.1f}s", file=sys.stderr)
    reply({"ready": True, "voices": kokoro.get_voices(), "model": os.path.basename(MODEL)})

    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            t0 = time.time()
            audio, rate = kokoro.create(req["text"], voice=req["voice"], speed=float(req.get("speed", 1.0)), lang=req.get("lang", "en-us"))
            audio = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
            sf.write(req["out"], audio, rate, subtype="PCM_16")
            reply({"id": req.get("id"), "ok": True, "samples": int(audio.shape[0]), "sampleRate": int(rate), "ms": int((time.time() - t0) * 1000)})
        except Exception as err:  # noqa: BLE001 - every failure goes back to the caller
            reply({"id": req.get("id"), "ok": False, "error": f"{type(err).__name__}: {err}"[:500]})


if __name__ == "__main__":
    main()
