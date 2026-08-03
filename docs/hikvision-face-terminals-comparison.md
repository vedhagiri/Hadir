# Hikvision Face Recognition Terminals — Comparison

> **Scope:** Side-by-side comparison of two Hikvision standalone
> face-recognition access-control terminals to support a hardware
> selection decision. Prepared for internal evaluation / client
> presentation.
>
> **Models compared:** `DS-K1T342MFWX-E1` (Value Series) vs
> `DS-K1T671MF` (Pro Series).

---

## What these devices are

Both are **standalone face-recognition access-control terminals** —
wall- or turnstile-mounted units that perform face matching **on the
device** to grant door access and log attendance. They are self-contained
(camera + screen + matching + door relay in one unit).

> **Note for Maugood integration:** these terminals are **not IP
> cameras** and do **not** stream RTSP into a central server the way
> Maugood's capture pipeline expects (IP camera → RTSP → server-side
> detection + matching). They are a separate, on-device attendance
> product. Evaluate them as a standalone alternative, not as a capture
> source for the Maugood pipeline. For Maugood testing, use Hikvision /
> Dahua IP dome/bullet cameras.

---

## Full comparison

| Feature | **DS-K1T342MFWX-E1 (Value)** | **DS-K1T671MF (Pro)** |
| --- | --- | --- |
| **Series** | Value Series | Pro Series |
| **Display** | 4.3" LCD Touch | **7" LCD Touch** |
| **Camera** | Dual 2 MP | Dual 2 MP Wide-angle |
| **Face capacity** | **1,500 faces** | **6,000 faces** |
| **Fingerprint capacity** | 3,000 | **5,000** |
| **Card capacity** | 3,000 | **6,000** |
| **Event logs** | **150,000** | 50,000 |
| **Recognition distance** | 0.3–1.5 m | **0.3–3 m** |
| **Recognition speed** | < 0.2 sec | < 0.2 sec |
| **Accuracy** | > 99% | > 99% |
| **Network** | 10/100 Mbps | **10/100/1000 Mbps (Gigabit)** |
| **Wi-Fi** | ✅ Yes | ❌ Ethernet only |
| **PoE** | ✅ Standard PoE | ❌ 12 V DC only |
| **USB ports** | 1 | **2** |
| **Alarm I/O** | Basic door control | **2 Alarm In + 1 Alarm Out** |
| **QR code** | No | **Yes** |
| **Two-way audio** | Yes | Yes |
| **IP rating** | Indoor / Basic | **IP65 Outdoor** |
| **Platform** | HikCentral, Hik-ProConnect | HikCentral, Hik-ProConnect |
| **Mask recognition** | Yes | Yes |
| **Deep-learning algorithm** | Yes | Yes |

---

## Product 1 — DS-K1T342MFWX-E1 (Value Series)

**Best for:** small offices, shops, small factories, attendance systems
with **fewer than 1,500 users**.

**Advantages**
- Lower price
- Built-in **Wi-Fi**
- Supports **PoE** (single Ethernet cable for power + network)
- Lower power consumption
- Large event storage (150,000 logs)

**Limitations**
- Smaller 4.3" display
- Maximum **1,500 faces**
- Shorter recognition distance (1.5 m)
- Fewer enterprise integration features

---

## Product 2 — DS-K1T671MF (Pro Series)

**Best for:** corporate offices, large factories, universities, airports,
enterprise access control.

**Advantages**
- Large 7" touchscreen
- Supports **6,000 faces** and **5,000 fingerprints**
- Reads **QR codes**
- Recognition up to **3 metres**
- **Gigabit** Ethernet
- More I/O for gates, alarms, sensors, integration
- Better suited for heavy daily usage
- **IP65**-rated for outdoor installation

**Limitations**
- Higher cost
- No built-in Wi-Fi
- Requires 12 V DC power (no standard PoE)

---

## Which one to choose

**Choose DS-K1T342MFWX-E1 (Value) if:**
- Fewer than 1,500 employees
- Cost-effective attendance device needed
- You want **Wi-Fi** or **PoE**
- Only basic door access + attendance required

**Choose DS-K1T671MF (Pro) if:**
- More than 1,500 users
- Enterprise-grade access control needed
- **QR code** authentication required
- Terminal installed **outdoors**
- Longer face-recognition distance required
- Deeper integration with alarms / security systems needed

---

## Recommendation

For an **enterprise AI attendance / face-recognition deployment**, the
**DS-K1T671MF (Pro Series)** is the stronger choice:

- Higher face database capacity (**6,000 users**)
- Longer recognition distance (**up to 3 m**)
- Better enterprise integration (alarm I/O, QR, Gigabit Ethernet)
- Suited to large office and industrial deployments
- More future-proof as the customer base grows

Use the **DS-K1T342MFWX-E1 (Value Series)** for smaller sites where Wi-Fi
/ PoE convenience and lower cost outweigh capacity and range.

---

## Before presenting to a client — verify these fields

The capacity and recognition-distance figures below were confirmed
against Hikvision's official datasheets. A few line items in the table
(event-log split, IP65 rating, PoE vs 12 V DC, QR-code support, Gigabit)
should be **re-checked against the current official datasheet for the
exact regional SKU** before quoting to a client, as they vary by revision
and region:

- Confirmed: 4.3" vs 7" display; 1,500 vs 6,000 faces; 3,000 vs 5,000
  fingerprints; 0.3–1.5 m vs 0.3–3 m distance; < 0.2 s speed; ≥ 99%
  accuracy; 342 has Wi-Fi.
- Re-verify per SKU: event-log capacity, IP65 outdoor rating, PoE
  support, Gigabit network, QR-code, alarm I/O count.

---

## Sources

- [DS-K1T342MFWX-E1 datasheet (Hikvision)](https://assets.hikvision.com/prd/public/all/doc/m000054133/DS-K1T342MFWX-Face-Recognition-Terminal_Datasheet_20231229.pdf)
- [DS-K1T671MF datasheet (Hikvision)](https://assets.hikvision.com/prd/public/all/doc/m000039808/DS-K1T671MF_Datasheet_20231227.pdf)
- Product pages: hikvision.com — Value Series `ds-k1t342mfwx-e1`,
  Pro Series `ds-k1t671mf`.
