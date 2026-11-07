/**
 * Page covers. A cover is stored as one string on the page: a preset key (`dawn`, `lake`, `moss`,
 * `dusk`, the gradients below), or an image address (`https:`, a same-origin path, a data image),
 * which P2's files upload fills. Anything else is treated as no cover.
 */
export const COVER_PRESETS = {
	dawn: 'linear-gradient(120deg, #f6d5c4 0%, #f2b7a0 45%, #d98e9a 100%)',
	lake: 'linear-gradient(120deg, #b7d4e6 0%, #8fb6d0 50%, #6a97b5 100%)',
	moss: 'linear-gradient(120deg, #cfe0c9 0%, #a8c7a0 50%, #7fa882 100%)',
	dusk: 'linear-gradient(120deg, #cbbfe0 0%, #a89ac9 50%, #8374b0 100%)',
	sand: 'linear-gradient(120deg, #efe6d2 0%, #e2d2b1 50%, #cdb68a 100%)',
	slate: 'linear-gradient(120deg, #d8dce2 0%, #b4bcc7 50%, #8e98a6 100%)'
} as const;

export type CoverPreset = keyof typeof COVER_PRESETS;

export const isCoverPreset = (value: string): value is CoverPreset => Object.hasOwn(COVER_PRESETS, value);

/** An image address a cover may load: https, a same-origin path or a data image. No script or other scheme. */
export const safeCoverUrl = (value: string): string | null => {
	const text = value.trim();
	if (/^https:\/\//i.test(text) || /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(text)) return text;
	if (text.startsWith('/') && !text.startsWith('//')) return text;
	return null;
};

/** The CSS `background` of a cover, or `null` for a value that is neither a preset nor a safe image. */
export function coverBackground(cover: string | null | undefined): { image: string; isImage: boolean } | null {
	if (!cover) return null;
	if (isCoverPreset(cover)) return { image: COVER_PRESETS[cover], isImage: false };
	const url = safeCoverUrl(cover);
	return url ? { image: `url("${url.replaceAll('"', '%22')}")`, isImage: true } : null;
}

/** A cover position is a percentage from the top (0) to the bottom (100) of the image; 50 centres it. */
export const clampPosition = (value: number | undefined | null): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50;
