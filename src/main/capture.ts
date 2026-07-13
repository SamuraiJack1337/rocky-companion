// In-memory screen capture for Rocky.
//
// Privacy is first-class here: screenshots are NEVER written to disk and the
// raw image bytes are NEVER logged. We capture a single thumbnail of the
// actively used display, downscale it so the longest edge fits within `maxEdge`,
// JPEG-encode it in memory, and hand back only a base64 string. Nothing is
// retained after the call returns — the NativeImage and its buffers go out of
// scope and become garbage.
//
// We also do a cheap "blank" check: if the captured frame is empty or reads as
// essentially all-black, that almost always means macOS Screen Recording
// permission has not been granted (the OS hands back a black frame rather than
// real pixels). Callers can use this to prompt the user instead of sending a
// useless black image to a model.

import { desktopCapturer, screen } from 'electron';

/** The result of a single capture. `base64` is JPEG bytes, base64-encoded. */
export interface CaptureResult {
  /** Base64-encoded JPEG bytes of the downscaled thumbnail. */
  base64: string;
  /** MIME type of the encoded bytes. Always 'image/jpeg' here. */
  mime: string;
  /** True when the frame was empty or effectively all-black (likely no permission). */
  blank: boolean;
}

/** JPEG quality for the encoded thumbnail (0-100). Small + good enough for vision. */
const JPEG_QUALITY = 72;

/** A channel value below this (0-255) counts as "near black" for blank detection. */
const NEAR_BLACK = 8;

/** Roughly how many pixels we sample across the frame for blank detection. */
const SAMPLE_TARGET = 200;

/**
 * Compute a thumbnail size whose LONGEST edge is <= maxEdge, preserving the
 * source aspect ratio. We size against the display's physical pixel dimensions
 * (logical size * scaleFactor) so Retina displays downscale correctly.
 */
function computeThumbnailSize(
  logicalWidth: number,
  logicalHeight: number,
  scaleFactor: number,
  maxEdge: number,
): { width: number; height: number } {
  const sf = scaleFactor > 0 ? scaleFactor : 1;
  // Physical pixel dimensions of the display.
  const physicalWidth = Math.max(1, Math.round(logicalWidth * sf));
  const physicalHeight = Math.max(1, Math.round(logicalHeight * sf));
  const longest = Math.max(physicalWidth, physicalHeight);

  // Already small enough — capture at native size, don't upscale.
  if (longest <= maxEdge) {
    return { width: physicalWidth, height: physicalHeight };
  }

  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(physicalWidth * ratio)),
    height: Math.max(1, Math.round(physicalHeight * ratio)),
  };
}

/**
 * Sample a spread of pixels from a BGRA bitmap and report whether the frame is
 * effectively all-black. The bitmap layout from NativeImage.getBitmap() is a
 * tightly packed Buffer of 4-byte BGRA pixels, row-major. We step through it
 * at a stride that yields roughly SAMPLE_TARGET samples and bail early the
 * moment we see any pixel with a channel at or above NEAR_BLACK.
 */
function looksBlank(bitmap: Buffer, width: number, height: number): boolean {
  const pixelCount = width * height;
  if (pixelCount <= 0 || bitmap.length < 4) return true;

  // Step across pixels so samples are spread over the whole frame.
  const stride = Math.max(1, Math.floor(pixelCount / SAMPLE_TARGET));

  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4; // 4 bytes per pixel (B, G, R, A)
    if (i + 2 >= bitmap.length) break;
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    // Any non-near-black channel means there's real content on screen.
    if (b >= NEAR_BLACK || g >= NEAR_BLACK || r >= NEAR_BLACK) {
      return false;
    }
  }
  // Every sampled channel was near zero.
  return true;
}

/**
 * Capture the display nearest the pointer in memory, downscale to fit `maxEdge`, and return
 * base64 JPEG bytes. Throws a friendly Error if no screen source is available.
 *
 * @param maxEdge Maximum length (in pixels) of the longest thumbnail edge. Default 1024.
 */
export async function captureScreen(maxEdge = 1024): Promise<CaptureResult> {
  const edge = Number.isFinite(maxEdge) && maxEdge > 0 ? Math.floor(maxEdge) : 1024;

  // The pointer is a better proxy for the display being actively used than the
  // OS "primary" flag, especially in multi-monitor workspaces.
  const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width: logicalWidth, height: logicalHeight } = activeDisplay.size;
  const scaleFactor = activeDisplay.scaleFactor;

  const thumbnailSize = computeThumbnailSize(logicalWidth, logicalHeight, scaleFactor, edge);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });

  if (sources.length === 0) {
    // Hard failure: no screen sources at all. On macOS this can also surface
    // when Screen Recording permission is fully blocked at the OS level.
    throw new Error(
      'No screen sources available to capture. Check macOS Screen Recording permission for this app.',
    );
  }

  // Prefer the source matching the active display; fall back to the first one.
  const activeId = String(activeDisplay.id);
  const source = sources.find((s) => s.display_id === activeId) ?? sources[0];

  const thumbnail = source.thumbnail;

  // Empty image → definitely blank (no usable frame).
  if (thumbnail.isEmpty()) {
    return { base64: '', mime: 'image/jpeg', blank: true };
  }

  // Inspect the raw pixels for an all-black frame (permission likely missing).
  const { width, height } = thumbnail.getSize();
  const bitmap = thumbnail.toBitmap();
  const blank = looksBlank(bitmap, width, height);

  if (blank) {
    // Don't bother encoding/returning a black frame's bytes.
    return { base64: '', mime: 'image/jpeg', blank: true };
  }

  // Encode to JPEG in memory and base64 it. Never persisted, never logged.
  const base64 = thumbnail.toJPEG(JPEG_QUALITY).toString('base64');

  return { base64, mime: 'image/jpeg', blank: false };
}
