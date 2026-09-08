# Image credits and licences

Internal note. This file lives outside `public/`, so it is **not** served to
visitors — Vercel publishes `public/` only. Nothing here appears on the site.

Keep it current whenever an image is added, replaced or removed.

---

## `public/img/dentist-at-work.jpg` — hero

| | |
|---|---|
| Original filename | `pexels-holoshuriken-18524124.jpg` |
| Apparent source | Pexels (filename pattern `pexels-<contributor>-<photo id>`) |
| Contributor handle | `holoshuriken` |
| Pexels photo id | `18524124` |
| Added | 2026-09-08 |
| Dimensions / size | 4000 × 5000 (4:5), 1.37 MB |
| Copied | **Byte-for-byte** from the supplied file — no resizing, re-encoding, cropping or editing of any kind |

The file on disk is bit-identical to the one that was supplied (verified by
SHA-256). All cropping is done in CSS with `object-fit` / `object-position`;
the picture itself has never been altered.

### The file carries a rights notice — do not strip it

Its XMP metadata contains:

```
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">DIJITAL AJANSIN</rdf:li></rdf:Alt></dc:rights>
```

That block is intact, and the byte-for-byte copy is what keeps it intact.
**Do not run this file through an optimiser, resizer or format converter** —
almost all of them discard XMP, which would delete a copyright notice from
someone else's work. If the file ever needs to be smaller, obtain a properly
licensed smaller copy instead of stripping this one.

### The licence has not been verified from the file

The filename matches Pexels' download convention, and the Pexels Licence
permits free commercial use, modification, and use without attribution. But a
filename is not proof of provenance, and the embedded rights claim above names
a different party. **This image is not copyright-free, and no amount of
cropping or editing would make it so.** Confirm the source before launch:
`https://www.pexels.com/photo/18524124/`

No attribution is displayed on the site, on the basis that the Pexels Licence
does not require it. If the real licence turns out to require credit, add it
to the page footer.

### The person in the photograph is identifiable and named

The dentist's scrub top carries embroidered text reading **"Dr. Yusuf İhsan
Yıldız"**. He is a real, identifiable person with no connection to Bright
Smile Dental Clinic.

The crops were chosen partly to keep that embroidery out of the frame:

| Breakpoint | Frame | Visible region of the source | Embroidery (≈71–92% x, 58–63% y) |
|---|---|---|---|
| Desktop (≥981px) | 3:5 tall | left 75% of the width, full height | a ~4% sliver at the extreme right edge |
| Tablet (701–980px) | 3:2 wide | full width, top 53% of the height | outside the crop |
| Mobile (≤700px) | 3:2 wide | full width, top 53% of the height | outside the crop |

Cropping reduces how prominent the name is; it does not change who owns the
photograph or who is depicted. The Pexels Licence does not grant the right to
imply that a person shown in an image endorses a business, and using this
photo as the hero of a clinic whose named dentist is "Dr. Asad" invites that
reading. Preferred fixes, in order:

1. A real photograph of Dr. Asad — removes the problem, and the About section
   needs one anyway.
2. A stock image in which no individual is identifiable.
3. Keep this image only with the client's informed agreement, and never
   caption or label it in a way that names or implies the dentist is theirs.

---

## `public/img/` — the other images

| File | Used by |
|---|---|
| `patient-smile.jpg` | Gallery — "Happy patients" |
| `hero-scanner.jpg` | Gallery — "Gentle care for every age"; also `og:image` |
| `room-chair.jpg` | **Currently unused** (was the hero before this change; kept on disk) |
| `room-equipment.jpg` | Gallery — "Latest equipment" |
| `aligners.jpg` | Gallery — "Clear aligners" |
| `implant-model.jpg` | Gallery — "Implant planning" |
| `xrays.jpg` | Gallery — "Digital x-rays" |
| `about-dentists.jpg` | About section |

Provenance for these predates this note and has not been verified. Confirm the
source and licence of every one of them before the site goes public.
