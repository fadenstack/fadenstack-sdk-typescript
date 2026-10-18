import { TRAINED_ALGORITHMIC_MEDIA } from "@fadenstack/client";

import { indexOfAscii, isImage } from "../content.js";
import type { ContentMarker, MarkOutcome, PlacedContent } from "../types.js";

/** What a picture's bytes carry of its provenance. */
export interface ImageMarks {
  /** A C2PA manifest store: a JUMBF box labelled `c2pa` (JPEG APP11, PNG `caBX`, WebP `C2PA`). */
  readonly c2pa: boolean;
  /** An XMP packet. */
  readonly xmp: boolean;
  /** The XMP names the IPTC source type for a picture a model made. */
  readonly trainedAlgorithmicMedia: boolean;
}

/**
 * Looks at a picture's bytes for its C2PA manifest and its XMP packet, without parsing either: a JUMBF superbox
 * (`jumb`) with a `c2pa` label, and an XMP packet (`x:xmpmeta`). Enough to tell whether a host re-encoded a picture
 * and dropped them; checking the signature is the detector's work.
 */
export function inspectImage(bytes: Uint8Array): ImageMarks {
  const jumbf = indexOfAscii(bytes, "jumb");
  const c2pa = jumbf >= 0 && indexOfAscii(bytes, "c2pa", Math.max(0, jumbf - 64)) >= 0;
  const xmpAt = indexOfAscii(bytes, "x:xmpmeta");
  const xmp = xmpAt >= 0 || indexOfAscii(bytes, "<?xpacket") >= 0;
  const source = TRAINED_ALGORITHMIC_MEDIA.slice(TRAINED_ALGORITHMIC_MEDIA.lastIndexOf("/") + 1);
  return { c2pa, xmp, trainedAlgorithmicMedia: xmp && indexOfAscii(bytes, source) >= 0 };
}

/**
 * Checks that a generated picture still carries its C2PA manifest (and XMP) as it is placed, and after, where the
 * host gives the bytes back: the server marks pictures as it makes them, and a host that re-encodes a picture (a
 * canvas, an editor's compression) drops them. Then it records `stripped-by-host`. It never changes the bytes: a
 * picture is placed as the same bytes, so the marks it came with stay. Its method is `c2pa`.
 */
export class ImageProvenanceGuard implements ContentMarker {
  readonly name = "image-guard";
  readonly layer = "metadata";

  supports(_sink: unknown, mediaType: string): boolean {
    return isImage(mediaType);
  }

  async attach(placed: PlacedContent): Promise<MarkOutcome> {
    if (!(placed.content instanceof Uint8Array)) return { applied: false, method: "c2pa", detail: "no bytes" };
    const given = inspectImage(placed.content);
    if (!given.c2pa) {
      return {
        applied: false, method: "c2pa", reason: "stripped-by-host",
        detail: given.xmp ? "no C2PA manifest before it was placed; XMP there" : "no C2PA manifest or XMP before it was placed",
      };
    }
    const back = await placed.readBack();
    if (!(back instanceof Uint8Array)) {
      return { applied: true, method: "c2pa", verified: false, detail: given.xmp ? "c2pa, xmp; not read back" : "c2pa; not read back" };
    }
    const after = inspectImage(back);
    return after.c2pa
      ? { applied: true, method: "c2pa", verified: true, detail: after.xmp ? "c2pa, xmp" : "c2pa" }
      : { applied: false, method: "c2pa", reason: "stripped-by-host", detail: after.xmp ? "the host kept XMP and dropped C2PA" : "the host re-encoded the picture" };
  }
}
