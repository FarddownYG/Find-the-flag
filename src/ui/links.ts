import type { Glyph } from '../core/types';
import { t } from '../i18n';
import { glyphSvg } from './glyph';
import { h, type Child } from './dom';

/** The "external link" symbol of the icon set (a box with an arrow leaving it). */
export const EXTERNAL_GLYPH: Glyph = {
  w: 24,
  h: 24,
  shapes: [
    { d: 'M14 4h6v6' },
    { d: 'M20 4l-9 9' },
    { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' },
  ],
};

/** The one URL shape that may leave the page: http(s), parsed (never matched by regex). */
export function safeHttpUrl(text: string): string | null {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export interface ExternalLinkOptions {
  class?: string;
  /** Replaces the default accessible "(opens in a new tab)" text. */
  title?: string;
}

/**
 * THE way to link outside the app: a new tab, no opener, no referrer, the external-link icon, and a
 * screen-reader note. Internal routes (`#/...`) are plain anchors and stay in the same tab, so the
 * file held in memory is never lost.
 */
export function externalLink(
  href: string,
  text: Child,
  opts: ExternalLinkOptions = {},
): HTMLAnchorElement {
  return h(
    'a',
    { class: opts.class, href, target: '_blank', rel: 'noopener noreferrer' },
    text,
    h('span', { class: 'ext-icon' }, glyphSvg(EXTERNAL_GLYPH)),
    h('span', { class: 'visually-hidden' }, ` (${opts.title ?? t('ui.links.newTab')})`),
  );
}

/** Untrusted text that looks like a URL: a link only when it is http(s), inert text otherwise. */
export function linkOrText(text: string): Node | string {
  const href = safeHttpUrl(text);
  return href ? externalLink(href, text) : text;
}
