✅ *END OF DAY UPDATE* — Harikrishnan
=======================================

🗓 23 Jun 2026

### *Project: Attendance Monitoring (Omran)*

✅ Done: Applied UC1/UC2 clip-processing speed optimizations — reduced frames-per-clip 60→30, YOLO image size 960→640, fixed even frame sampling, and fixed the crop-accumulation bug on reprocess.
✅ Done: Cut release **v1.1.24** (version bump + release bundle).
✅ Done: Backfilled and pushed all missing git tags **v1.1.6 → v1.1.23**.
✅ Done: Built a one-shot client data collection script + an offline UC1 benchmark script.
✅ Done: Took a ~1 hour backup of the client machine (clips + DB config + logs + embeddings) before tomorrow's handover, and analyzed it.
✅ Done: Root-caused the "missing faces" issue from client logs — the motion-skip setting is too aggressive and skips frames that contain faces (logs show frames=30, skipped=29, faces found=0). Also confirmed client CPU is fully saturated (~1500%) under load.

⏳ Pending: Implement the UC1 recall fix (lower motion-skip) + face-crop quality upgrade — plan ready, awaiting go-ahead before coding.
⏳ Pending: Push today's 2 local commits + the v1.1.24 tag (waiting on confirmation).

🚧 *Blockers:* Client machine is handed over tomorrow — all required data already backed up today, so no impact.

💬 *Plan for Tomorrow:* Implement the recall-first UC1 fix (reduce motion-skip so faces are no longer missed) and the higher-quality face-crop encoding, then validate against the collected client clips using the offline benchmark.
