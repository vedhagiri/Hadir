"""Offline UC1 detection benchmark — run AFTER the client handover, on your
own box, against the decrypted sample clips from collect-uc1.sh.

It exercises the real detection path (``maugood.detection.detect`` via
``reprocess._run_detection`` + ``_sample_frames``) so the numbers match
production, but needs NO database, no tenant, no Fernet — just plain .mp4s.

Run inside the backend image (it has cv2 + insightface + the code):

    # single config
    docker compose run --rm -v "$PWD/clips:/bench" backend \\
        python -m scripts.benchmark_uc1 /bench --imgsz 960 --motion-skip 0 --max-frames 60

    # sweep the speed/recall knobs across all clips
    docker compose run --rm -v "$PWD/clips:/bench" backend \\
        python -m scripts.benchmark_uc1 /bench --sweep

    # test the detector-lock throughput (the "how to handle the lock" question):
    # run N clips' detection concurrently and compare to serial
    docker compose run --rm -v "$PWD/clips:/bench" backend \\
        python -m scripts.benchmark_uc1 /bench --concurrency 1,2,3,4

Reports per-config: total EXTRACT seconds, seconds/clip, seconds/processed-frame,
total faces found, and frames skipped by motion. For --concurrency it reports
wall-clock + effective speedup vs serial, which tells you whether replacing the
single ``_detect_lock`` with a Semaphore(N) is worth it on this hardware.
"""

from __future__ import annotations

import argparse
import glob
import os
import threading
import time
from pathlib import Path

from maugood.person_clips import reprocess as rp


def _clips(path: str) -> list[str]:
    if os.path.isdir(path):
        return sorted(glob.glob(os.path.join(path, "**", "*.mp4"), recursive=True))
    return sorted(glob.glob(path))


def _sample(clip: str, max_frames: int) -> list:
    rp._MAX_FRAMES_PER_CLIP = max_frames  # module knob used by _sample_frames
    frames, _interval, _fps = rp._sample_frames(Path(clip), 25.0)
    return frames


def _detect(frames: list, imgsz: int, motion_skip: float):
    """Returns (frame_results, total_faces, extract_seconds) for one clip."""
    results, extract_s = rp._run_detection(
        frames, "yolo+face", None, use_case="uc1",
        motion_skip_threshold=motion_skip, yolo_imgsz=imgsz,
    )
    faces = sum(len(d) for _, d in results)
    return results, faces, extract_s


def _crop(frames: list, frame_results: list) -> tuple[int, float]:
    """Time the CPU cropping work — composite-quality scoring + track
    association + best-per-track crop cut/encode — mirroring UC1's
    ``_save_face_crops_uc1_best_per_track`` MINUS the DB insert + Fernet
    write (I/O, not the optimization target). Returns (n_crops, crop_seconds).
    """
    import cv2  # noqa: PLC0415
    from maugood.person_clips.reprocess import (  # noqa: PLC0415
        _uc2_associate_into_tracks, _uc2_composite_quality,
    )
    t0 = time.time()
    qualities: dict = {}
    for fi, dets in frame_results:
        frame = frames[fi] if 0 <= fi < len(frames) else None
        if frame is None:
            continue
        for di, det in enumerate(dets):
            qualities[(fi, di)] = _uc2_composite_quality(frame, det)
    tracks = _uc2_associate_into_tracks(frame_results)
    dets_by_frame = {fi: dets for fi, dets in frame_results}
    n = 0
    for _tid, members in tracks.items():
        if not members:
            continue
        best = max(members, key=lambda k: qualities.get(k, (0.0, {}))[0])
        fi, di = best
        frame = frames[fi] if 0 <= fi < len(frames) else None
        dets = dets_by_frame.get(fi) or []
        if frame is None or di >= len(dets):
            continue
        bbox = dets[di].get("bbox")
        if not bbox:
            continue
        x1, y1, x2, y2 = (int(v) for v in bbox)
        h, w = frame.shape[:2]
        pw, ph = int((x2 - x1) * 0.30), int((y2 - y1) * 0.30)
        x1, y1 = max(0, x1 - pw), max(0, y1 - ph)
        x2, y2 = min(w, x2 + pw), min(h, y2 + ph)
        if x2 <= x1 or y2 <= y1:
            continue
        crop = frame[y1:y2, x1:x2]
        if getattr(crop, "size", 0) == 0:
            continue
        short = min(crop.shape[:2])
        if short < 200:
            sc = 200.0 / short
            crop = cv2.resize(crop, (int(crop.shape[1] * sc), int(crop.shape[0] * sc)),
                              interpolation=cv2.INTER_CUBIC)
        cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        n += 1
    return n, time.time() - t0


def run_config(clips: list[str], imgsz: int, motion_skip: float, max_frames: int) -> None:
    label = f"imgsz={imgsz} motion_skip={motion_skip} max_frames={max_frames}"
    print(f"\n=== {label} ===")
    tot_extract = tot_crop = 0.0
    tot_faces = tot_frames = tot_crops = 0
    t_wall = time.time()
    for c in clips:
        frames = _sample(c, max_frames)
        results, faces, extract_s = _detect(frames, imgsz, motion_skip)
        n_crops, crop_s = _crop(frames, results)
        tot_extract += extract_s
        tot_crop += crop_s
        tot_faces += faces
        tot_frames += len(frames)
        tot_crops += n_crops
        print(f"  {os.path.basename(c):24s} frames={len(frames):3d} "
              f"faces={faces:3d} crops={n_crops:3d} "
              f"extract={extract_s:6.1f}s crop={crop_s:5.2f}s "
              f"total={extract_s + crop_s:6.1f}s")
    wall = time.time() - t_wall
    per_frame = (tot_extract / tot_frames) if tot_frames else 0.0
    print(f"  ── clips={len(clips)} faces={tot_faces} crops={tot_crops} "
          f"frames={tot_frames} extract={tot_extract:.1f}s "
          f"({per_frame:.2f}s/frame) crop={tot_crop:.1f}s "
          f"total={tot_extract + tot_crop:.1f}s wall={wall:.1f}s")


def run_concurrency(clips: list[str], levels: list[int], imgsz: int,
                    motion_skip: float, max_frames: int) -> None:
    """Pre-sample once, then run detection on the clip set at each concurrency
    level. Detection funnels through the module-level _detect_lock today, so
    speedup should be ~flat. If you patch the lock to a Semaphore(N), rerun
    this to see whether throughput actually scales on this CPU."""
    print(f"\n=== concurrency test (imgsz={imgsz} max_frames={max_frames}) ===")
    sampled = [_sample(c, max_frames) for c in clips]
    base = None
    for n in levels:
        sem = threading.Semaphore(n)
        t0 = time.time()
        threads = []

        def worker(frames: list) -> None:
            with sem:
                _detect(frames, imgsz, motion_skip)

        # cap *offered* concurrency to n by launching in waves the semaphore gates
        for frames in sampled:
            th = threading.Thread(target=worker, args=(frames,))
            th.start()
            threads.append(th)
        for th in threads:
            th.join()
        wall = time.time() - t0
        if base is None:
            base = wall
        print(f"  N={n:2d}  wall={wall:7.1f}s  speedup_vs_N1={base / wall:4.2f}x")
    print("  (note: with today's single _detect_lock, speedup stays ~1.0x even "
          "as N rises — that IS the bottleneck. Patch to Semaphore(N) and rerun.)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Offline UC1 detection benchmark")
    ap.add_argument("clips", help="directory or glob of plain .mp4 clips")
    ap.add_argument("--imgsz", type=int, default=960)
    ap.add_argument("--motion-skip", type=float, default=0.0)
    ap.add_argument("--max-frames", type=int, default=60)
    ap.add_argument("--sweep", action="store_true",
                    help="run a recall/speed knob sweep")
    ap.add_argument("--concurrency", default="",
                    help="comma list of concurrency levels, e.g. 1,2,3,4")
    args = ap.parse_args()

    clips = _clips(args.clips)
    if not clips:
        print(f"no .mp4 clips found at {args.clips}")
        return
    print(f"{len(clips)} clip(s); inference threads="
          f"{os.environ.get('MAUGOOD_INFERENCE_THREADS', '2')}")

    if args.concurrency:
        levels = [int(x) for x in args.concurrency.split(",") if x.strip()]
        run_concurrency(clips, levels, args.imgsz, args.motion_skip, args.max_frames)
        return

    if args.sweep:
        # recall-first vs speed-first vs balanced
        run_config(clips, imgsz=960, motion_skip=0.0, max_frames=60)   # recall-first
        run_config(clips, imgsz=640, motion_skip=0.0, max_frames=60)   # imgsz only
        run_config(clips, imgsz=640, motion_skip=5.0, max_frames=30)   # current v1.1.24
        run_config(clips, imgsz=960, motion_skip=2.0, max_frames=60)   # recall + light skip
        return

    run_config(clips, args.imgsz, args.motion_skip, args.max_frames)


if __name__ == "__main__":
    main()
