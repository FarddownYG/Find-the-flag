/**
 * The sample messages of the Enigma tool: made-up plaintexts run through the tool's own engine.
 * scripts/gen-samples-enigma.mjs writes them to public/samples/; the tests rebuild them and
 * compare, so the files and the engine cannot drift apart. Nothing here is real traffic or a real
 * challenge: the texts are invented (weather and a demo flag) and the settings are arbitrary.
 *
 *   enigma-m3-weather.txt  M3, rotors VII V II, UKW-B, rings A A A, start K C T, no plugboard.
 *                          Starts with the crib WETTERBERICHT (the classic weather report).
 *   enigma-m4-flag.txt     M4, Beta VI I III, UKW-B-thin, rings A A B C, start J X Q M, no plugboard.
 *                          Has the crib FLAGENIGMA in the middle.
 *   enigma-i-plug.txt      Enigma I, rotors III I II, UKW-B, rings C A F, start M W P, 10 plugboard
 *                          pairs. Hides FLAGENIGMAROTORSSTEP.
 */
import { Enigma, letterValues, lettersString, readSetup, type SetupText } from './_enigma';

export interface Sample {
  file: string;
  settings: SetupText;
  plain: string;
}

export const SAMPLE_M3: Sample = {
  file: 'enigma-m3-weather.txt',
  settings: {
    machine: 'm3',
    rotors: 'VII V II',
    reflector: 'B',
    rings: 'A A A',
    start: 'K C T',
    plugboard: '',
  },
  plain:
    'WETTERBERICHTXPLANQUADRATXANXZWONEUNXWINDXNORDWESTXSTAERKEXVIERXSEEGANGXDREIXSICHTXGUTXKEINEXBESONDERENXEREIGNISSEXENDE',
};

export const SAMPLE_M4: Sample = {
  file: 'enigma-m4-flag.txt',
  settings: {
    machine: 'm4',
    rotors: 'Beta VI I III',
    reflector: 'B-thin',
    rings: 'A A B C',
    start: 'J X Q M',
    plugboard: '',
  },
  plain: 'ANXALLEXSTATIONENXFLAGENIGMAFOURWHEELSXKEINEXFEINDBERUEHRUNGXENDE',
};

export const SAMPLE_PLUG: Sample = {
  file: 'enigma-i-plug.txt',
  settings: {
    machine: 'enigma1',
    rotors: 'III I II',
    reflector: 'B',
    rings: 'C A F',
    start: 'M W P',
    plugboard: 'BQ CR DI EJ KW MT OS PX UZ GH',
  },
  plain: 'FLAGENIGMAROTORSSTEP',
};

export const SAMPLES = [SAMPLE_M3, SAMPLE_M4, SAMPLE_PLUG];

/**
 * Two historic messages used by the examples (the tests hold their own copy of the same data).
 * Operation Barbarossa message, June 1941, Enigma I: Walzenlage II IV V, Ringstellung B U L,
 * Grundstellung B L A, ten plugboard pairs; the plaintext is the German order of the day.
 */
export const BARBAROSSA = {
  settings: {
    machine: 'enigma1',
    rotors: 'II IV V',
    reflector: 'B',
    rings: 'B U L',
    start: 'B L A',
    plugboard: 'AV BS CG DL FU HZ IN KM OW RX',
  } satisfies SetupText,
  cipher:
    'EDPUD NRGYS ZRCXN UYTPO MRMBO FKTBZ REZKM LXLVE FGUEY SIOZV EQMIK UBPMM YLKLT TDEIS ' +
    'MDICA GYKUA CTCDO MOHWX MUUIA UBSTS LRNBZ SZWNR FXWFY SSXJZ VIJHI DISHP RKLKA YUPAD ' +
    'TXQSP INQMA TLPIF SVKDA SCTAC DPBOP VHJK',
};

/**
 * M4 message of the U-264, November 1942, one of those broken by the M4 Message Breaking Project:
 * UKW B-thin, Beta II IV I, Ringstellung A A A V, Grundstellung V J N A, ten plugboard pairs.
 */
export const U264 = {
  settings: {
    machine: 'm4',
    rotors: 'Beta II IV I',
    reflector: 'B-thin',
    rings: 'A A A V',
    start: 'V J N A',
    plugboard: 'AT BL DF GJ HM NW OP QY RZ VX',
  } satisfies SetupText,
  cipher:
    'NCZW VUSX PNYM INHZ XMQX SFWX WLKJ AHSH NMCO CCAK UQPM KCSM HKSE INJU SBLK IOSX CKUB ' +
    'HMLL XCSJ USRR DVKO HULX WCCB GVLI YXEO AHXR HKKF VDRE WEZL XOBA FGYU JQUK GRTV UKAM ' +
    'EURB VEKS UHHV OYHA BCJW MAKL FKLM YFVN RIZR VVRT KOFD ANJM OLBG FFLE OPRG TFLV RHOW ' +
    'OPBE KVWM UQFM PWPA RMFH AGKX IIBG',
};

/** Encrypt a plaintext of letters with the sample's settings. */
export function encryptLetters(settings: SetupText, plain: string): string {
  const machine = new Enigma(readSetup(settings));
  return lettersString(letterValues(plain).map((v) => machine.press(v)));
}

/** Blocks of five letters, ten blocks to a line. */
export function formatGroups(letters: string): string {
  const groups = letters.match(/.{1,5}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 10) lines.push(groups.slice(i, i + 10).join(' '));
  return `${lines.join('\n')}\n`;
}

export function buildSamples(): Record<string, string> {
  return Object.fromEntries(
    SAMPLES.map((s) => [s.file, formatGroups(encryptLetters(s.settings, s.plain))]),
  );
}
