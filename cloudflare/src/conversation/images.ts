// The images `read` gives the model, prepared by Cloudflare Images. pi-durable's Photon processor decodes in the
// isolate: 241 MB of WebAssembly memory for a 12-megapixel photo, which never shrinks again, far over a Durable
// Object's 128 MB. The Images binding decodes and resizes outside the isolate, so a phone photo costs us only its
// bytes. An image already within the model's limits is passed on as it is, with no transformation billed.

import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import { base64 } from "../lib/bytes.ts";

/** The formats every provider takes inline (pi-durable's INLINE_IMAGE_TYPES). */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The qualities tried at each size, best first. */
const QUALITIES = [80, 60];
/** Sizes tried, each 3/4 of the one before, after the largest that fits the limits. */
const SIZES = 3;

const streamOf = (bytes: Uint8Array) => new Blob([bytes]).stream();
const base64Length = (byteLength: number) => 4 * Math.ceil(byteLength / 3);

export function cloudflareImages(images: ImagesBinding): ImageProcessor {
	return {
		async prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> {
			let info: ImageInfoResponse;
			try {
				info = await images.info(streamOf(bytes));
			} catch {
				// Not an image Images can read.
				return undefined;
			}
			if (!("width" in info)) return undefined;
			const { width, height } = info;
			if (INLINE.has(mimeType) && width <= limits.maxWidth && height <= limits.maxHeight && base64Length(bytes.byteLength) <= limits.maxBytes) {
				return { data: base64(bytes), mimeType };
			}
			// Photos stay JPEG; anything else becomes WebP, which keeps transparency.
			const format = mimeType === "image/jpeg" ? "image/jpeg" : "image/webp";
			let scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
			for (let size = 0; size < SIZES; size++, scale *= 0.75) {
				const to = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
				for (const quality of QUALITIES) {
					const result = await images
						.input(streamOf(bytes))
						.transform({ width: to.width, height: to.height, fit: "scale-down" })
						.output({ format, quality, anim: false });
					const data = await new Response(result.image({ encoding: "base64" })).text();
					if (data.length > limits.maxBytes) continue;
					const resized = to.width !== width || to.height !== height;
					return {
						data,
						mimeType: format,
						...(resized ? { resized: { from: { width, height }, to } } : {}),
						...(format !== mimeType ? { convertedFrom: mimeType } : {}),
					};
				}
			}
			return undefined;
		},
	};
}
