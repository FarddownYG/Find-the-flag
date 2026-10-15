/**
 * Fixtures of the Symmetric ciphers tool: neutral plaintext encrypted with the `openssl` command
 * line (OpenSSL 3.0), so the tool is checked against the reference implementation rather than
 * against itself. Used by the examples and by symmetric.test.ts. The passphrase is a public demo
 * value; none of this is a real challenge.
 *
 * Regenerate with the commands in the comments (the Salted__ blobs carry a random salt, so a new
 * run gives a different, equally valid, blob).
 */

export const PLAINTEXT = 'Find The Flag symmetric test';
export const PASSPHRASE = 'ctf-demo-pass';

/** printf '%s' "$PLAINTEXT" | openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -pass pass:$PASSPHRASE -a */
export const SALTED_PBKDF2 = 'U2FsdGVkX186qa6hSrW0/UM+gkldLhuR26KIW4e2JquFTcQV66VUquCpIMHSLuk+';
/** … openssl enc -aes-256-cbc -md md5 -pass pass:$PASSPHRASE -a   (OpenSSL before 1.1.0 default) */
export const SALTED_MD5 = 'U2FsdGVkX1+31MZsxYcEUXf3iBD+UJ20DoURlHOsFe5QxASWIQAT9sBLIDo18CLF';
/** … openssl enc -aes-256-cbc -pass pass:$PASSPHRASE -a   (EVP_BytesToKey with SHA-256) */
export const SALTED_SHA256 = 'U2FsdGVkX18eePybRECHwE2A1tLmWN7Jah6zUZfgpZQ2KbvzwYTGcTr5WDfW5rAG';
/** … openssl enc -aes-192-cbc -md sha1 -pass pass:$PASSPHRASE -a */
export const SALTED_AES192_SHA1 =
  'U2FsdGVkX1+cP8SHvg7hFivall43soJiwHyh43Uw5pT07seWoorOMzuEUSJl0EE+';
/** … openssl enc -aes-128-cbc -pbkdf2 -iter 1000 -md sha512 -pass pass:$PASSPHRASE -a */
export const SALTED_PBKDF2_SHA512 =
  'U2FsdGVkX1/X09M6v8Q06WzjEhC7jz/apCgPdseuQvRpbie6KoITjt2XMcMzjoU0';
/** … openssl enc -aes-128-ctr -pbkdf2 -pass pass:$PASSPHRASE -a   (a stream mode: no padding) */
export const SALTED_CTR = 'U2FsdGVkX1/fZ2Quy88kJe74LL/5iELX8mVWj/gocfdryiZy0Uq532MUVKc=';
/** … openssl enc -des-ede3-cbc -md md5 -pass pass:$PASSPHRASE -a */
export const SALTED_3DES_MD5 = 'U2FsdGVkX19rJTlztoomcSbw5xBtxnV/V9TH/wuhPBoN8YXbI84Kh4j54pMX0lA6';
/** … openssl enc -rc4 -provider legacy -provider default -md md5 -pass pass:$PASSPHRASE -a */
export const SALTED_RC4_MD5 = 'U2FsdGVkX1/yZgHKYtjtY2+Qfud7W6ppVFQ0JSohgQOMOIozWf1SWdusYgo=';
/** … openssl enc -aes-256-cbc -md md5 -nosalt -pass pass:$PASSPHRASE -a   (no Salted__ header) */
export const NOSALT_MD5 = 'cZ2HGdtvxRgIi4EGNjdz12tBlG3UB5cQ8Wg/8eC9dzE=';
/** … openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -S 0011223344556677 -pass pass:$PASSPHRASE
 *  (with -S, openssl writes the bare ciphertext: no Salted__ header) */
export const PBKDF2_BODY_SALT_0011 = '0011223344556677';
export const PBKDF2_BODY_BASE64 = '4tNW9IQ4h+Cgqgc1HxTuOdHAgi6qkFVPT2f7ZCtJxQs=';

export const KEY16 = '000102030405060708090a0b0c0d0e0f';
export const KEY24 = `${KEY16}1011121314151617`;
export const KEY32 = `${KEY16}101112131415161718191a1b1c1d1e1f`;
export const IV16 = '0f0e0d0c0b0a09080706050403020100';
export const IV8 = '0001020304050607';

/** printf '%s' "$PLAINTEXT" | openssl enc -<cipher> -K <key> [-iv <iv>] | od -An -tx1 -v … */
export const RAW = {
  aes128ecb: '89169fed5e4e56fa6da05103cd67b114fac8881eaca68e298f9e66b856f542f0',
  aes128cbc: 'f17bdc0bb94d8c9de0650f22ef57dc02dbefb91e4311ac93f2db04138cff8b02',
  aes128ctr: '66c097f69418338d245990bd0b8eea132acbc1d1073703641ad7e298',
  aes128cfb: '66c097f69418338d245990bd0b8eea13329385ddb48258aade859136',
  aes128ofb: '66c097f69418338d245990bd0b8eea138963481b350bc3e5f06158ff',
  aes192cbc: '8bcaf288ccd0a99662678e356f418d6d5d9cb4834cc8b9479fd620184a230937',
  aes256cbc: '6c26a0c997302da27d1dc8064880afbacb9e03c8b83eb6a6247b2fac362b2619',
  aes256ecb: '140f77d78a0dfd7932137a6c3eff18f294f2845343d8078ed72ee3dff679e7ca',
  tdes3cbc: 'e970684e5625ce6993d8d0bb20f590907ce3db833bf6e4b3262e234d12494370',
  tdes3ecb: 'f45ddd706716868b64c64a4fb929d4b72ef86f5050a3cb65d208ec654dfa4da6',
  tdes3cfb: '1e844aeb57a2d9fb58226f01220e5a07c65fc27ec645b1cdd94815be',
  tdes3ofb: '1e844aeb57a2d9fb679fdb2b287a95143c40d1fa3ae897b5382c401e',
  /** des-ede-cbc: two-key 3DES (K3 = K1), key = the first 16 bytes. */
  tdes2cbc: '2ec51e9177978aa67e3cdfa93e452016784edf57811ea7e3627a56e630846c98',
  /** des-cbc / des-ecb with the key 0001020304050607 (legacy provider). */
  descbc: '7d50c55f3abcfda2ac69099de0e3bd5918b76ac5c29c094e472e4c2a86ebd048',
  desecb: '47be555b451cf530df2248bffe3ad4f763cb01ffe77cbee4456409498073d8a5',
  /** rc4 with the 16-byte key KEY16 (legacy provider). */
  rc4: 'aff52e9d67b671a9269dfba769fd5936be1ce42b80de21cefbfbd6ad',
  /** chacha20 with the key KEY32 and the 16-byte IV 01000000 || 000000000000004a00000000. */
  chacha20: '64263f97604fb1840f984b0edf436e94e17e7af64f4565c20a2ab998',
} as const;

export const CHACHA_IV16 = '01000000000000000000004a00000000';
