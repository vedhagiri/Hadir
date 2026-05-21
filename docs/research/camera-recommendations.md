# Camera Recommendations for Maugood

> **Audience:** procurement + deployment engineers picking IP cameras for
> Maugood attendance sites.
> **Last updated:** 2026-05-20

## 1. Why this document exists

The pilot is currently running on **CP Plus CP-UNC-DA41L3C-D-LQ** — a
4 MP entry-level IP dome. It works for daytime attendance under good
lighting, but in mixed-light and multi-camera deployments it shows:

- frame drops under sustained RTSP pull at 4 fps
- soft / blurred faces beyond ~3 m, especially in IR mode
- inconsistent FPS reporting (advertised 25 fps, actual 12–18 fps over
  RTSP main stream during low-light)
- limited bitrate ceiling for the H.264 main stream

This document proposes better-suited replacements for v1.0 production
deployments at Omran and future tenants.

## 2. Maugood architecture constraints (non-negotiable)

Any recommended camera **must** satisfy all of the following — these
are load-bearing for Maugood capture (`backend/maugood/capture/`):

| Constraint                              | Why                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **RTSP main + sub stream**              | P7 reader parses `rtsp://` only — scheme allowlist tightened in P27 (`rtsp`/`rtsps`)                    |
| **PoE (802.3af or higher)**             | Single-cable LAN install at Omran; UPS is centralised on the PoE switch, not per-camera                 |
| **Stable ≥4 fps over RTSP**             | P28.5a reader runs at camera-native fps, analyzer at ≤6 fps — sub-4 fps cameras starve the analyzer    |
| **H.264 main profile**                  | OpenCV `cv2.VideoCapture` over FFmpeg is the most stable codec path; H.265 works but burns more CPU    |
| **ONVIF Profile S**                     | Used by Maugood's preview probe + future PTZ work                                                       |
| **Minimum 4 MP @ ≥15 fps main stream**  | Below 4 MP, faces beyond 3 m fall under InsightFace's `min_face_pixels=60` threshold from P28.5c       |
| **Built-in IR or low-light sensor**     | Omran HQ corridors run mixed light; ColorVu / Starlight / IR-cut is the bar                             |
| **No proprietary cloud lock-in**        | Maugood is on-prem; cameras must work standalone with local RTSP                                        |

## 3. Recommended cameras

> All prices are **approximate INR retail (May 2026)** and shift with
> stock + GST + regional pricing. Convert to OMR / AED at the time of
> procurement. Amazon links are **search links** — verify the SKU
> matches the model number before ordering, listings churn.

| # | Camera Name                                  | Camera Type           | Resolution         | RTSP Support                | PoE / Ethernet              | Night Vision                     | Face Detection Suitability                                            | Approx. Price (INR) | Amazon Buy Link                                                                                  | Recommended Use Case                                                          |
|---|----------------------------------------------|-----------------------|--------------------|-----------------------------|-----------------------------|----------------------------------|-----------------------------------------------------------------------|---------------------|---------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| 1 | **Hikvision DS-2CD2143G2-I** (AcuSense)      | IP Bullet / Dome      | 4 MP (2560×1440)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | IR 30 m, smart IR                | **Excellent.** Built-in person/face filter cuts garbage events upstream | ₹8,500 – ₹10,500    | [Search Amazon.in](https://www.amazon.in/s?k=Hikvision+DS-2CD2143G2-I)                            | **Primary recommendation.** Main entrance + corridor; 24×7 attendance lanes   |
| 2 | **Hikvision DS-2CD2T47G2-L** (ColorVu)       | IP Bullet             | 4 MP (2560×1440)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | **Full-colour night (F1.0 lens)**| **Best-in-class face crops at night** — no IR wash-out                | ₹13,500 – ₹15,500   | [Search Amazon.in](https://www.amazon.in/s?k=Hikvision+DS-2CD2T47G2-L)                            | Outdoor entry gates + low-lux lobbies — replaces CP Plus where IR fails       |
| 3 | **Dahua IPC-HFW2431S-S-S2** (Starlight)      | IP Bullet             | 4 MP (2688×1520)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | Starlight + IR 80 m              | Strong face crops in dim light; H.265+ smart codec                    | ₹7,000 – ₹8,500     | [Search Amazon.in](https://www.amazon.in/s?k=Dahua+IPC-HFW2431S-S-S2)                             | Mid-range alternative to Hikvision; good for car-park / perimeter             |
| 4 | **Dahua IPC-HDW3441T-ZAS** (AI WizSense)     | IP Eyeball Dome       | 4 MP (2688×1520)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | IR 40 m, smart IR                | **On-camera face attribute** (gender/age) — useful as second filter   | ₹14,000 – ₹16,000   | [Search Amazon.in](https://www.amazon.in/s?k=Dahua+IPC-HDW3441T-ZAS)                              | Indoor mid-traffic doors; motorised lens (2.7-13.5 mm) for variable mounting  |
| 5 | **Uniview IPC3614SR3-ADF28KM-G** (LightHunter)| IP Dome              | 4 MP (2688×1520)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | LightHunter colour-at-night      | Solid face crops; **strong value tier** — under ₹6,000                | ₹5,500 – ₹6,500     | [Search Amazon.in](https://www.amazon.in/s?k=Uniview+IPC3614SR3-ADF28KM-G)                        | Budget rollout to satellite offices; first-camera per branch                  |
| 6 | **Hikvision DS-2CD2387G2-LU** (ColorVu+AcuSense)| IP Bullet           | 8 MP (3840×2160)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | Full-colour night (F1.0)         | **Sharpest face crops at distance** — 8 MP overshoots min_face_pixels  | ₹17,500 – ₹20,000   | [Search Amazon.in](https://www.amazon.in/s?k=Hikvision+DS-2CD2387G2-LU)                           | Wide-angle entrances (>5 m to face), reception desks with stand-back queues   |
| 7 | **Axis M3216-LVE**                           | IP Dome (vandal)      | 4 MP (2688×1512)   | RTSP main+sub, ONVIF S + T  | 802.3af PoE + RJ45          | IR + Forensic WDR                | **Premium tier** — Axis Zipstream halves bandwidth without hurting face IQ | ₹35,000 – ₹42,000   | [Search Amazon.in](https://www.amazon.in/s?k=Axis+M3216-LVE)                                      | High-security floors (server room, finance) — Axis SLA + warranty matters     |
| 8 | **CP Plus CP-VNC-V41L3-MDS** (Cosmic series) | IP Bullet             | 4 MP (2560×1440)   | RTSP main+sub, ONVIF S      | 802.3af PoE + RJ45          | IR 30 m, smart IR                | One tier above the pilot's `CP-UNC-DA41L3C-D-LQ` — better face IQ      | ₹6,500 – ₹7,500     | [Search Amazon.in](https://www.amazon.in/s?k=CP+Plus+CP-VNC-V41L3-MDS)                            | **Like-for-like swap** at Omran without changing vendor                       |

## 4. Recommendation by site type

| Site profile                                     | Pick                                  | Why                                                                            |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------ |
| Omran HQ — main entrance (24×7)                  | **Hikvision DS-2CD2143G2-I**          | Best balance of price, AcuSense filter, on-cam upstream noise reduction        |
| Omran HQ — low-light corridor / outdoor lobby    | **Hikvision DS-2CD2T47G2-L** (ColorVu)| IR wash kills face match accuracy; ColorVu solves it                           |
| Mid-distance attendance lane (3–5 m to face)     | **Dahua IPC-HFW2431S-S-S2**           | Starlight handles mixed light, costs ~20% less than ColorVu                    |
| Distant / wide entrance (>5 m, queue stand-back) | **Hikvision DS-2CD2387G2-LU** (8 MP)  | At distance, 4 MP faces drop below 60 px; 8 MP keeps them above threshold      |
| Budget multi-branch rollout                      | **Uniview IPC3614SR3-ADF28KM-G**      | LightHunter night colour at ~₹6k; lowest TCO for the SKU list                  |
| High-security wing                               | **Axis M3216-LVE**                    | Axis has the longest field MTBF of the list + region SLA                       |
| Stay-with-CP-Plus (vendor continuity)            | **CP Plus CP-VNC-V41L3-MDS**          | Same vendor, same install crew, meaningfully better optics than the pilot SKU  |

## 5. Mounting + RTSP-URL conventions

Once a camera is chosen, the same operational rules apply regardless of
vendor:

- **Mount height**: 2.2 – 2.6 m for face capture at the door plane.
  Above 3.0 m forces a steep angle that crops the forehead and starves
  InsightFace.
- **Lens choice**: 2.8 mm for entries ≤3 m, 4 mm for 3 – 5 m, motorised
  lens (Dahua HDW3441T-ZAS) for variable mounts.
- **RTSP URL**: stick to the main stream for face capture. Sub-stream
  cuts CPU but drops resolution below the `min_face_pixels` threshold.
- **Codec**: H.264 main profile. H.265 / H.265+ works but increases
  decode CPU per worker — verify on the smallest tenant first.
- **Authentication**: every camera ships with a default password. Rotate
  before plugging into Maugood — the RTSP password lands Fernet-encrypted
  in `cameras.rtsp_url_encrypted` (P7) and stays there for the camera's
  life.

## 6. What we did **not** recommend, and why

| Excluded camera class                  | Reason                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Wi-Fi-only cameras (TP-Link Tapo, etc.)| No PoE, Wi-Fi RTSP under load drops 30%+ frames — kills attendance accuracy             |
| Cloud-bridged cameras (Ring, Nest)     | No on-prem RTSP; would force outbound calls Maugood doesn't allow                       |
| Action cameras / NVR-bundled SKUs      | RTSP URL is undocumented or vendor-locked to their NVR                                  |
| Sub-2 MP cameras                       | Face crops fall under InsightFace's min_face_pixels at any realistic install distance   |
| Fisheye / 360° cameras                 | Distortion hurts face embedding consistency; revisit only if the room geometry demands  |

## 7. Validation procedure before bulk procurement

Before ordering more than 2 of any new SKU, run the **Maugood
camera-bring-up** procedure on a single unit:

1. Provision the camera in `cameras` table via the Admin UI; confirm
   the preview endpoint (`GET /api/cameras/{id}/preview`) returns a
   frame within 5 s.
2. Watch the per-worker stats (`GET /api/operations/workers` from P28.8)
   for one hour. Targets: `fps_reader ≥ 12`, `fps_analyzer ≥ 4`,
   `motion_skipped_pct ≥ 30%` in a quiet corridor.
3. Walk past the camera 10 times at the install distance. Targets:
   `detection_events_total` increments 10× ± 1, identified rate
   ≥ 90% on a person with at least 3 reference photos.
4. Eyeball the saved face crops in `/data/faces/captures/{tenant}/…`
   — sharp, unblurred, no IR wash, frontal capture. Reject the SKU if
   crops are consistently soft.
5. Run for 24 h. Pull `camera_health_snapshots` — `reachable=true`
   should be ≥99% of minute-buckets.

Only after this validation should the SKU enter the procurement standard
for that site.

## 8. Out-of-scope for this doc

- **NVRs**: Maugood does not need an NVR — capture + storage happens in
  the backend. If site security policy requires an NVR for forensic
  retention beyond Maugood's 90-day capture window, treat that as a
  parallel system.
- **Camera-side analytics licences**: AcuSense / WizSense / LightHunter
  are useful **before** the stream hits Maugood but Maugood doesn't
  depend on them — the on-prem InsightFace pipeline is authoritative.
- **Cabling + switch sizing**: per-camera bandwidth budget at 4 MP H.264
  main stream is ~4–6 Mbps. A 24-port PoE switch with 250 W budget
  handles 24 cameras comfortably.

---

*Document owner: Maugood deployment lead.
Update cadence: per camera-tier procurement decision.*
