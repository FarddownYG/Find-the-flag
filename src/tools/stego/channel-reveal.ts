import { bool, defineTool, number, select } from '../../core/define';
import type { Output, RgbaImage } from '../../core/types';
import {
  CHANNEL_INFO,
  DEFAULT_REVEAL,
  channelInfo,
  inkOnlyApplies,
  normalizeOptions,
  revealDetailed,
  statsHint,
  type Stretch,
} from './_channel';

/** Share of the region's pixels that are dark grey or black (all three components close and low). */
function greyShare(img: RgbaImage, rect: { x: number; y: number; w: number; h: number }): number {
  const d = img.data;
  // Every 4th pixel of every 4th row is plenty for a share above 0.5 %.
  let seen = 0;
  let grey = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 4) {
    for (let x = rect.x; x < rect.x + rect.w; x += 4) {
      const i = (y * img.width + x) * 4;
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      const hi = Math.max(r, g, b);
      seen++;
      if (hi < 170 && hi - Math.min(r, g, b) < 16) grey++;
    }
  }
  return seen ? grey / seen : 0;
}

const STRETCH_LABEL: Record<Stretch, string> = {
  none: 'no stretch',
  auto: 'auto stretch (1–99 %)',
  full: 'full-range stretch',
  equalize: 'equalized',
};

export default defineTool({
  id: 'channel-reveal',
  name: 'Channel reveal (R/G/B/C/M/Y/K)',
  category: 'stego',
  description:
    'Isolate one colour channel (R, G, B, alpha, C, M, Y, K, luma) and amplify it to reveal faint yellow dots, near-white text and other colour-channel steganography.',
  tags: [
    'channel',
    'colour channel',
    'color channel',
    'blue channel',
    'yellow dots',
    'printer dots',
    'tracking dots',
    'docucolor',
    'machine identification code',
    'invisible ink',
    'near white',
    'faint',
    'contrast',
    'amplify',
    'stretch',
    'equalize',
    'threshold',
    'stegsolve',
    'cmyk',
    'rgb',
    'steganography',
  ],
  input: 'image',
  placeholder:
    'Drop a PNG or BMP scan (exact pixels). JPEG works, but its compression noise can drown faint signals.',
  live: true,
  options: {
    channel: select(
      'Channel',
      CHANNEL_INFO.map((c) => ({ value: c.id, label: `${c.name} (${c.formula})` })),
      DEFAULT_REVEAL.channel,
      {
        hint: 'Yellow dots on white paper only differ in the blue channel: use Blue + Invert, or Yellow.',
      },
    ),
    inkOnly: bool('Colour ink only', false, {
      hint: 'R/G/B/C/M/Y: keep only coloured ink — how far the channel is below the two others (yellow = min(R, G) − B) — so black text, grey shading and white paper all go flat. Off = the plain channel values.',
    }),
    invert: bool('Invert', DEFAULT_REVEAL.invert, {
      hint: 'Faint ink is darker than the paper in its own channel. Inverting makes it bright on black. Blue + Invert is identical to Yellow without Invert.',
    }),
    stretch: select(
      'Contrast stretch',
      [
        { value: 'auto', label: 'Auto (1st–99th percentile)' },
        { value: 'full', label: 'Full range (min–max)' },
        { value: 'equalize', label: 'Equalize histogram' },
        { value: 'none', label: 'None' },
      ],
      DEFAULT_REVEAL.stretch,
      {
        hint: 'Auto maps the 1st–99th percentile to black–white, widened to reach a faint signal that covers under 1 % of the pixels (dots on a noisy page). Full range never clips.',
      },
    ),
    gain: number('Gain', DEFAULT_REVEAL.gain, {
      min: 0,
      max: 255,
      step: 0.5,
      hint: 'Multiplier applied after the stretch. With stretch None, a gain of 10 to 20 lifts very faint signals.',
    }),
    gamma: number('Gamma', DEFAULT_REVEAL.gamma, {
      min: 0.1,
      max: 10,
      step: 0.1,
      hint: 'Above 1 brightens the mid-tones, below 1 darkens them.',
    }),
    threshold: number('Threshold', DEFAULT_REVEAL.threshold, {
      min: 0,
      max: 255,
      hint: '0 = off. Otherwise every level from this value up becomes white and the rest black.',
    }),
    cropX: number('Crop X', 0, { min: 0, hint: 'Left edge of the region, in pixels.' }),
    cropY: number('Crop Y', 0, { min: 0, hint: 'Top edge of the region, in pixels.' }),
    cropW: number('Crop width', 0, {
      min: 0,
      hint: '0 = up to the right edge. With every crop field at 0 the whole image is shown. Crop to the corner with the dots, then zoom.',
    }),
    cropH: number('Crop height', 0, { min: 0, hint: '0 = down to the bottom edge.' }),
    zoom: number('Zoom', DEFAULT_REVEAL.scale, {
      min: 1,
      max: 16,
      hint: 'Whole-number zoom, nearest neighbour (pixels stay sharp). Crop to a corner, then zoom.',
    }),
  },
  examples: [
    {
      label: 'Invisible text: blue channel, inverted',
      input: { sample: 'channel-faint-text.png' },
      expect: 'Range: 236–255',
    },
    {
      label: 'Same signal as the yellow channel',
      input: { sample: 'channel-faint-text.png' },
      options: { channel: 'y', invert: false },
      expect: 'Range: 0–19',
    },
    {
      label: 'Red channel: nothing hidden',
      input: { sample: 'channel-faint-text.png' },
      options: { channel: 'r' },
      expect: 'Red channel is constant (255)',
    },
    {
      label: 'Crop one word and zoom ×4',
      input: { sample: 'channel-faint-text.png' },
      options: { cropX: 20, cropY: 56, cropW: 90, cropH: 24, zoom: 4 },
      expect: 'Output: 360×96 px',
    },
  ],
  run({ image }, o) {
    const opts = normalizeOptions({
      channel: o.channel,
      inkOnly: o.inkOnly,
      invert: o.invert,
      stretch: o.stretch,
      gain: o.gain,
      gamma: o.gamma,
      threshold: o.threshold,
      crop: { x: o.cropX, y: o.cropY, w: o.cropW, h: o.cropH },
      scale: o.zoom,
    });
    const res = revealDetailed(image, opts);
    const info = channelInfo(opts.channel);
    const { rect } = res.crop;
    const out: Output[] = [];

    if (res.crop.adjusted) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `The crop did not fit the ${image.width}×${image.height} image and was adjusted: showing ${rect.w}×${rect.h} px at (${rect.x}, ${rect.y}).`,
      });
    }
    if (res.reduced > 1) {
      out.push({
        type: 'note',
        level: 'info',
        text: `The ${rect.w}×${rect.h} region is shown reduced ×${res.reduced} (${res.image.width}×${res.image.height}), each block keeping its most signal-like pixel so small dots survive. Crop a region to see real pixels.`,
      });
    }
    if (res.scale < opts.scale) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Zoom lowered from ×${opts.scale} to ×${res.scale} to keep the picture under 16 million pixels. Crop a smaller region to zoom further.`,
      });
    }

    const inkOnly = opts.inkOnly === true && inkOnlyApplies(opts.channel);
    const steps = [
      `${info.name} channel`,
      inkOnly ? 'colour ink only' : null,
      opts.invert ? 'inverted' : null,
      STRETCH_LABEL[opts.stretch],
      opts.gain !== 1 ? `gain ×${opts.gain}` : null,
      opts.gamma !== 1 ? `gamma ${opts.gamma}` : null,
      opts.threshold > 0 ? `threshold ≥ ${opts.threshold}` : null,
    ].filter((s): s is string => s !== null);
    out.push({
      type: 'image',
      label: steps.join(', '),
      image: res.image,
      filename: `channel-${opts.channel}.png`,
    });

    const { stats } = res;
    out.push({
      type: 'kv',
      label: 'Channel statistics',
      entries: [
        [
          'Channel',
          `${info.name} (${info.formula})${
            inkOnly
              ? ', colour ink only'
              : opts.inkOnly
                ? ' (colour ink only does not apply to this channel)'
                : ''
          }`,
        ],
        [
          'Region',
          res.crop.whole
            ? `${rect.w}×${rect.h} px (whole image)`
            : `${rect.w}×${rect.h} px at (${rect.x}, ${rect.y}) of ${image.width}×${image.height}`,
        ],
        ['Range', `${stats.min}–${stats.max}`],
        ['Mean', stats.mean.toFixed(2)],
        ['p1', String(stats.p1)],
        ['p99', String(stats.p99)],
        [
          'Output',
          `${res.image.width}×${res.image.height} px (${res.reduced > 1 ? `reduced ×${res.reduced}` : `zoom ×${res.scale}`})`,
        ],
      ],
    });

    const hint = statsHint(opts.channel, stats);
    if (hint) out.push({ type: 'note', level: 'info', text: hint });
    if (!inkOnly && inkOnlyApplies(opts.channel) && greyShare(image, rect) >= 0.005)
      out.push({
        type: 'note',
        level: 'info',
        text: 'Black or grey content (text, shading) shows in every channel. Turn on Colour ink only to keep coloured ink alone — yellow dots, coloured stamps.',
      });
    out.push({ type: 'note', level: 'info', text: 'Processed locally — nothing uploaded.' });
    return out;
  },
});
