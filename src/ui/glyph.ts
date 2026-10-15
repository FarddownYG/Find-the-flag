import type { Glyph } from '../core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 'ink' is the page's text colour; the symbol keys set their own ink in CSS. */
const colour = (c: string | undefined, fallback: string): string =>
  c === undefined ? fallback : c === 'ink' ? 'currentColor' : c;

/**
 * A drawn symbol as an inline SVG element, built with the DOM API (no markup string is ever
 * parsed). Decorative: the button or cell that holds it carries the accessible name.
 */
export function glyphSvg(glyph: Glyph): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${glyph.w} ${glyph.h}`);
  svg.setAttribute('width', String(glyph.w));
  svg.setAttribute('height', String(glyph.h));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const shape of glyph.shapes) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', shape.d);
    path.setAttribute('fill', colour(shape.fill, 'none'));
    path.setAttribute('stroke', colour(shape.stroke, 'currentColor'));
    if (shape.stroke !== 'none') path.setAttribute('stroke-width', String(shape.width ?? 3));
    if (shape.opacity !== undefined) path.setAttribute('opacity', String(shape.opacity));
    svg.appendChild(path);
  }
  return svg;
}
