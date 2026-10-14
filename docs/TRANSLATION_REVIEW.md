# Translations to review

The interface ships in five languages. English is the source. The French, Russian, Chinese and Hindi
files were written and then proofread without a native speaker, so the Russian, Chinese and Hindi
ones need a native review (**relecture native à faire**). This page lists the keys the translators
and proofreaders were least sure about, as a starting point. Keys are in `src/i18n/locales/<lang>.json`;
`node scripts/i18n.mjs missing <lang>` lists anything untranslated and `npm run i18n:check` validates a change.

How to fix one: edit the value in the locale file (keep every `{placeholder}` and the technical terms of
`src/i18n/glossary.json`), then run `npm run i18n:check`.

## Russian (ru)

Noted by the translators:

- forensics (pcap, archive, file-type, strings, sig.*): tool.pcap.label.conversations, tool.pcap.options.mode.choices.exfil, tool.archive.value.gzipMembers, sig.lz4, sig.regf, sig.pgp-armor
- forensics (pcap, archive, file-type, strings, sig.*): ru notes phrased "Label: {count}" to avoid number agreement (e.g. tool.pcap.note.malformed)
- image stego core (tool.image-structure, qr, lsb, bit-planes): image-structure.gif.gceDetail*, gif.trailer, chunk.sTER, chunk.mDCV, chunk.cICP, sof.*, bit-planes.value.noise
- text stego (tool.text-analyzer, zero-width, whitespace): note.shouted, note.binaryData, pass.tapCode, note.hillClimb, pass.railFence, examples.musset-to-sand
- misc + esolangs: tool.whitespace-lang.value.desc.* (+ note.auto / note.readFrom), text.betweenMarkers/textStart/textEnd, tool.piet.value.slid, value.stoppedInWhite
- image analyzer, channel reveal, docucolor, printer dots: "noun: N" phrasing (image-analyzer.problem.ifd-cut, problem.value-outside, problem.thumb-outside, note.capped; printer-dots.value.threshold-*, value.blobs, warn.inliers); "плитка" for tile;…

Noted by the proofreaders:

- `tool.morse-audio.error.nyquist`: Units are left as Latin "Hz" (and "s" in tool.morse-audio.error.short). This matches what the code prints ("700.0 Hz", "60 ms") and the dtmf and spectrogram tools, so I left it. A native speaker may prefer Гц/с across the whole locale.
- `tool.rsa.detail.hastadFailed`: "padding" is kept in Latin script ("использовался padding"). It is a common technical loanword, but «дополнение» could also work.
- `tool.whitespace-lang.text.tried_few`: "this one {does}" is translated as «это {does}». It is grammatical but a little vague; «выбранное извлечение {does}» would be clearer.
- `tool.rsa.description`: The attack names Håstad, Wiener and Fermat stay in Latin script as proper names. Russian texts often write Хостад, Винер, Ферма.
- `tool.dtmf.col.column / col.row / col.length / col.pause / col.start / error.lowRate / options.frameMs.label; tool.spectrogram.error.freqRange / options.maxFreq.label / options.minFreq.label / options.ceiling.label / options.floor.label / value.axes / value.fft / value.peak / value.resolution`: Units are written in Latin script (Hz, ms, s, dB) where standard Russian is Гц, мс, с, дБ. I left them because the code itself outputs 'Hz' (e.g. '8000 Hz', fmtHz in spectrogram.ts), and tool.morse-audio (not in this chunk) also uses Hz. A native speaker…
- `tool.hash-identify.name`: 'Hash identifier' was left in English in all four locales (fr, zh, hi too), which might have been on purpose. I translated the ru one to 'Определитель hash'. Please confirm, and align the other locales if wanted.
- `tool.image-structure.chunk.sRGB`: The usual Russian colour-management term could also be 'Намерение рендеринга' or 'Способ цветопередачи'. I chose 'Метод рендеринга'.
- `tool.image-structure.chunk.sTER`: 'Стереораскладка': 'раскладка' usually means a keyboard layout. 'Стереокомпоновка' may read better. I left it unchanged.
- `sig.lz4`: 'Кадр LZ4' translates 'frame' literally. The LZ4 frame format is often called 'фрейм LZ4' in Russian. I left it unchanged.
- `tool.docucolor.value.parity-failed / tool.docucolor.value.cell-fail / tool.docucolor.value.parity-fixed`: FAIL/FAILED is shown as «СБОЙ», which means 'malfunction'. The parity note uses «НЕ СОШЛАСЬ» instead. Left unchanged; a native speaker may prefer «НЕ СОШЛАСЬ» or «ОШИБКА» for consistency.
- `tool.text-analyzer.note.shouted_*`, `tool.whitespace.detect.spaces_*` / `tabs_*`: rephrased as "noun: X из Y" so the verb no longer has to agree with the first number.
- `tool.text-analyzer.pass.chained`: «Шифры на «{source}»» is a calque of 'ciphers on X'. «Шифры поверх «{source}»» may read better. Left as is because the meaning is understandable.
- `cat.encoding.blurb`: «Системы base» for 'Bases' (the base64/32/58 family) is understandable but unusual Russian. Left unchanged.
- `tool.file-type.note.embeddedZip`: It points to the 'Carve' tool, but ru.json has no tool.carve.name yet, so the Russian name to cite is not known.
- `tool.esolang.options.seed.hint`: It uses the English word 'seed' inside Russian prose (the label explains it in parentheses). Left as is because 'seed' is common jargon.
- `tool.hash.text.size`: Changed the wording so it is correct for any count ('hex-цифр: 32, бит: 128'). A native speaker should confirm it reads well inside the two noMatchSameSize* notes and noMatchSize.
- `tool.printer-dots.note.ambiguous_other`: The fraction-form changes (this key, outvoted_other, structure-many_other, rescued_other, copies_other, text-transform.note.dropped_other) follow the genitive-singular rule for decimals. These counts are always whole numbers, so the forms never show, but a…
- `tool.printer-dots.col.at`: The column header 'Где (px)' is understandable but unusual; 'Позиция (px)' might be more natural. Left unchanged as a style choice.
- `tool.base32.description`: 'padding' stays in Latin script here, in tool.base32.examples.lowercase-no-padding, and in tool.base64.description (another chunk). The option label says 'Дополнять знаком ='. Left as jargon for consistency; 'дополнение' would be the Russian word.
- `*_other forms (docucolor.note.none-passes, printer-dots.value.of-positions, zero-width.text.none/detect.invisible, text-analyzer.note.capitals/innerCapitals/doubled/doublesNothing/shouted/spacesFound/spacesTypographic/tooShortSkipped, text.moreHomoglyphs, bacon.error.symbols, whitespace-lang.note.invisible/text.coverAdded/tried/triedFailed, piet.value.slid, rsa.detail.hastadWorked)`: I followed the convention the reviewers set: with a fraction, the adjective and noun take the genitive singular (2,5 разного символа). A native speaker should confirm it. These forms are only used for non-integer counts, so the UI never shows them.
- `tool.text-analyzer.note.tooShortSkipped_other`: «{count} слишком короткой пропущено» uses a substantivised adjective with no noun; it reads stiffly.
- `tool.hash.note.newline + tool.hash.variant.added/removed`: «{names} совпадает с добавленным в конце переводом строки» can be read as 'matches the newline'. A clearer wording («совпадает, если добавить перевод строки в конце») would mean rewording the variant keys as well. Not changed.
- `tool.archive.error.notArchive, archive.note.gzipTrailing_*, file-type.note.embeddedZip, image-structure.error.other/otherSig, auto-decode.note.file, archive.note.gap_*`: These still name Carve / Carve embedded files / Hexdump in English, because tool.carve.name and tool.hexdump.name have no ru translation yet (other agents). Once those exist, update these references. archive.error.notArchive also uses the unquoted full…
- `tool.dtmf.label.multitap vs tool.text-analyzer.pass.multitap`: 'multi-tap' is written in Latin in one key and as «мультитап» in the other. Both are acceptable, so I did not pick one.
- `base32/base58/base85/base91/binary/morse/esolang/number-base/charcode/timestamp/whitespace-lang error messages`: These quote literals with ASCII "…", while lib.*, jwt, polybius and others use «…». Inconsistent, but it is a style choice, so I left it.

## Simplified Chinese (zh)

Noted by the translators:

- forensics (pcap, archive, file-type, strings, sig.*): sig.pgp-armor, sig.regf, tool.pcap.options.mode.choices.exfil
- image stego core (tool.image-structure, qr, lsb, bit-planes): image-structure.chunk.mDCV, qr.how.flatWhite/flatBlack, image-structure.value.ok, bit-planes.channel.*
- text stego (tool.text-analyzer, zero-width, whitespace): pass.atbash, pass.boustrophedon, pass.multitap, note.sentenceStarts, note.shorter
- misc + esolangs: tool.whitespace-lang.note.hidden (+ text.coverAdded/coverCleaned), tool.piet.value.pushed/popped/read/printed
- image analyzer, channel reveal, docucolor, printer dots: value.parity-of.* (奇/偶 + 校验); 图块 for tile

Noted by the proofreaders:

- `tool.bacon.error.fewLetters`: 'cover text' is translated as 掩护文本 here and in zero-width and whitespace-lang. That is consistent, but the usual steganography term may be 载体文本. A native speaker should decide on one term for all three tools.
- `tool.bacon.value.variant`: '{variant} 字母' (e.g. '24 字母') is short and drops the measure word. This also applies to label.best and options.variant.choices.24/26. '24 字母版' might read more naturally.
- `tool.frequency.kv.cipherOrder`: 密文顺序 is meant as 'cipher letters sorted by frequency' but could be read as 'the order of the ciphertext'. 密文频率顺序 would be clearer; it is paired with 英文顺序.
- `tool.whitespace-lang.value.bare.lead`: 第一行含有它们的行之前的行都被跳过 is grammatical but awkward. 它们 refers to the trailing spaces/tabs.
- `tool.auto-decode.options.flagPrefix.hint`: '包含 前缀{...} 的候选优先' has a loose space after 包含. It might read better with quotes: 包含“前缀{...}”的候选优先.
- `tool.rsa.warn.noModulus`: {at} is ' label' with a leading space, so the result reads '实例 1没有模数 n' with no space after the label. This is a minor typography issue.
- `tool.image-structure.error.other`: I kept “Carve” because the carve tool has no zh name yet (tool.carve.* is missing from zh.json). Once it gets one, both error.other and error.otherSig should use it.
- `tool.hash-identify.name`: Left as the English "Hash identifier", the same as in fr/ru/hi (it is probably the proper name of the known tool hash-identifier). Someone should confirm this was intended.
- `tool.base85.error.notInAlphabet`: Literal characters and tokens in base85, base91, charcode and morse errors use ASCII quotes ("{char}", "{token}"), while UI labels use “”. I left this alone because ASCII quotes are a reasonable way to quote raw data, but a native speaker may want one…
- `tool.bit-planes.col.looks`: The column header 看起来 ("looks") reads like a verb. It is understandable next to its values (类似噪声 / 有结构), so I left it; 外观 or 判断 would be more natural as a header.
- `tool.whitespace.text.tooLittle`: I rendered 'the whitespace map below' as 空白字符可视化图 so it matches the map label. A native speaker should check that it reads naturally.
- `tool.url.options.scope.choices.reserved`: '仅限保留字符' sits under the scope label 编码. It should be read as 'encode only the reserved characters'; please confirm it is clear.
- `tool.text-analyzer.pass.atbash`: The current text is 'Atbash 埃特巴什码' (Latin name and Chinese name side by side with no punctuation). I left it, but '埃特巴什码（Atbash）' may read better. The same applies to note.viaAtbash.
- `tool.image-combine.examples.twin-images`: '双胞胎图片' is a literal translation of 'Twin images'. I left it as acceptable, but '两张相似的图片' may be more natural.
- `tool.text-analyzer.note.iocFlat`: text-analyzer says 单表替换 here and in pass.substitution, but the substitution tool says 单表代换/代换密码. Both are correct Chinese; a native speaker may want to pick one term.
- `tool.hash.text.size`: '{digits} 位 hex（{bits} 位）' uses 位 for both hex digits and bits. This is common usage, but '{digits} 个 hex 字符（{bits} 比特）' would be clearer. Left unchanged.
- `tool.channel-reveal.options.inkOnly.hint`: 'go flat' was rendered literally as 都会变平. It is understandable, but a native speaker might prefer a phrasing like 变成均匀的一片. Left unchanged.
- `tool.printer-dots.value.parity-ok`: The value 'OK' is kept as English (also cell-ok, and 奇偶校验 OK in note.sure, note.ambiguous and note.implausible), while FAILED is translated as 失败. 通过 would pair better. Left as accepted loanword usage.
- `tool.jwt.options.extra.placeholder`: '用,逗号,分隔' uses half-width commas on purpose, to show the input format. A native speaker could prefer an example like 猜测1,猜测2,猜测3.
- `tool.channel-reveal.examples.same-signal-as-the-yellow-channel`: '黄色通道中的相同信号' says 'the same signal in the yellow channel'. The example shows the yellow channel matching blue + invert, so '与“蓝色”+“反相”相同的信号（黄色通道）' may be clearer. Left unchanged.
- `tool.whitespace-lang.name`: Changed 'Whitespace (esolang)' to 'Whitespace（深奥编程语言）'. fr, ru and hi all keep '(esolang)', so confirm a zh reader would not rather see the jargon word.
- `tool.image-analyzer.description`: Aligned 追加数据 to 附加数据 for 'appended data' (also in detect.simple and finding.nothing-value). Both are correct Chinese; the change is only for consistency. value.appended keeps the verb '被追加'.
- `tool.unicode-escape.options.style.choices.U`: Bracket alignment inside the dropdown (also u, u-brace and the three esolang language choices). It is close to a style choice; revert if mixed bracket styles in a list are acceptable.

## Hindi (hi)

Noted by the translators:

- forensics (pcap, archive, file-type, strings, sig.*): tool.pcap.label.conversations, tool.archive.kv.madeOn, tool.pcap.value.na
- image stego core (tool.image-structure, qr, lsb, bit-planes): image-structure.chunk.* (transliterations), qr.how.flatWhite/flatBlack, image-structure.gif.gceDetail*, lsb.value.rowMajor/colMajor
- text stego (tool.text-analyzer, zero-width, whitespace): pass.nthWordOfLine, pass.nthLetterOfLine, pass.everyNthChar, note.fromLetter/fromChar, note.iocFlat, pass.combining, examples.musset-to-sand
- misc + esolangs: tool.whitespace-lang.note.hidden, text.coverLines, text.coverAdded, value.desc.markersOwn, tool.esolang.text.bytesPrinted/stepsExecuted
- image analyzer, channel reveal, docucolor, printer dots: image-analyzer.value.region._; docucolor.value.orientation-short._

Noted by the proofreaders:

- `tool.binary.detect.odd`: 'length odd' (the bits fail to decode as 8- or 7-bit groups) is rendered as असामान्य लंबाई ('unusual length'). Left as is, but 'लंबाई 8/7 के गुणज में नहीं' might be clearer.
- `tool.frequency.verdict.plain`: 'columnar' (columnar transposition) is rendered as just कॉलम. Left as is; a native speaker may prefer कॉलम-आधारित.
- `tool.rsa.detail.wienerFailed`: Keeps an English gloss: अभिसारी (convergent). Acceptable, but check it reads naturally.
- `tool.morse-audio.error.nyquist`: The proper name Nyquist is kept in Latin script, like Vigenère, Atbash and Wiener elsewhere. A native speaker may prefer नाइक्विस्ट.
- `tool.number-base.kv.textBE`: big-endian and little-endian stay in Latin script across tool.number-base.* and tool.pcap.format.*. Kept as technical terms; please confirm this is wanted.
- `tool.pcap.error.empty`: Uses चिपकाया गया (also in tool.pcap.error.tooShort) where the shell says पेस्ट. Both are correct; left as is.
- `tool.hash-identify.name`: Still in English ('Hash identifier') in fr, ru, zh and hi alike, so it looks deliberate (hash-identifier is also a known CTF tool). I left it. If it should be translated: 'hash पहचानकर्ता'.
- `tool.piet.label.run`: 'रन' (block title for the run summary) can make a Hindi reader think of a cricket run. tool.whitespace-lang.label.run uses the same word and is outside my chunk. Possible alternative: 'प्रोग्राम रन' or 'निष्पादन'.
- `tool.image-structure.gif.gceDetail`: 'disposal' stays in Latin script (a GIF field name), the same way 'twist' in tool.dtmf.options.strict.hint does. A native speaker might prefer 'डिस्पोज़ल'.
- `tool.image-structure.note.noSof`: 'start-of-frame' stays in English as a JPEG term. It could be 'SOF (start-of-frame)'.
- `tool.image-analyzer.finding.taken`: New text 'फ़ोटो लेने का समय'. The value can also come from the CreateDate or ModifyDate fallback tags. Please check the wording reads naturally.
- `tool.esolang.note.befungeDivZero_*, befungeOutside_*, befungeStack`: 'push'/'pop' are left in Latin script. The whitespace-lang hi strings do the same, so I kept them as stack-operation names. A native speaker may prefer पुश/पॉप
- `tool.qr.description, tool.qr.how.margin`: 'quiet zone' is left in Latin as a QR spec term. क्वाइट ज़ोन may read better
- `tool.qr.how.flatBlack, tool.qr.how.flatWhite`: 'पारदर्शिता काले/सफ़ेद पर समतल की गई' is a literal rendering of 'transparency flattened on black/white' (alpha composited onto a background). It is understandable but stiff
- `tool.text-analyzer.note.wrapped`: 'टूटा हुआ गद्य?' for 'wrapped prose?' (a sentence continuing onto the next line). कई पंक्तियों में बँटा गद्य may be clearer
- `tool.text-analyzer.note.typedOn`: Fixed the gender to के बटनों. कीज़ might be the more natural word for keyboard keys
- `tool.file-type.placeholder`: Uses चिपकाएँ while the shell says पेस्ट करें everywhere else. I left it because it is a style choice, not an error
- `tool.archive.note.locked_one`: Uses चैलेंज ('challenge text') while ui.home.lede uses चुनौतियों. Both appear about equally often in hi.json, so left as is. A native speaker could pick one.
- `tool.archive.kv.madeOn`: Changed to 'किस सिस्टम पर बना' (the value is the gzip host OS). 'बनाने वाला सिस्टम' is another option.
- `tool.timestamp.label.bytesLittleEndian`: Made बाइट masculine to match most of the locale. Hindi tech writing also uses बाइट as feminine, so please confirm.
- `ui.home.looksLike`: The h2 heading above the list of guessed tools reads 'यह ऐसा लगता है'. It is acceptable but stiff; 'ऐसा लगता है' or 'संभावित टूल' may read better.
- `tool.hash.note.noMatchSameSizeHmac`: 'salt' is kept in Latin script inside the Hindi prose (also in noMatchSameSizeKey). It is a crypto term, so left alone; it could be transliterated as सॉल्ट.
- `(nukta normalization, 108 keys)`: Policy choice: the nukta on क/ख/ग was dropped and ज़/फ़ were kept. A native reviewer may prefer the opposite policy, adding the nukta everywhere (ख़ाली, ग़लत, आख़िरी…). Either way is consistent now.
- `tool.auto-decode.note.tried_one/_other etc.`: कैंडिडेट was chosen to match jwt and rsa. Check that it reads naturally for decoded-string candidates.
- `tool.archive.error.notArchive, tool.archive.note.gzipTrailing_*, tool.file-type.note.embeddedZip, tool.image-structure.error.other/otherSig`: These name the Carve tool in English ('Carve' or 'Carve embedded files') because tool.carve.name has no hi value yet. If the carve agent gives it a Hindi name, these 6 keys must follow it. The same applies to Hexdump (tool.hexdump.name pending). Also,…
- `line/row and value`: Not changed. 'line' is पंक्ति in text-analyzer, whitespace and hash-identify, but लाइन in whitespace-lang, text-transform, rsa and strings. 'Value' is मान (24 keys) or वैल्यू (39 keys). Both forms are correct and each tool is mostly consistent within…

## French (fr)

Noted by the proofreaders:

- `tool.rsa.note.decrypted_other`: Reworded to 'Déchiffrement réussi pour {solved} des {count} chiffrés', which is correct for any solved/count. A native speaker should confirm it reads naturally.
- `tool.pcap.value.outOfOrder_one`: Kept 'hors d’ordre', which is a common calque in French networking texts. 'hors séquence' might be more idiomatic.
- `tool.pcap.where.joined`: '(concaténés)' is masculine plural, but some {group} values are feminine ('Requêtes ICMP echo…'). One fixed form cannot agree with every group.
- `tool.pcap.error.badMagic`: Keeps the English 'magic bytes', as tool.file-type.description does, while lsb uses 'octets magiques'. Left as is because it is common jargon. Pick one term if consistency matters.
- `tool.zero-width.col.kind`: 'Sorte' (also 'Sortes différentes' in kv.kinds) is understandable, but 'Type' is the more usual French column label.
- `tool.hash-identify.name`: Left as the English 'Hash identifier' on purpose: every locale keeps it, and fr tool.hash.note.noMatchSize (outside this chunk) refers to it by that name. If it should be translated, 'Identificateur de hash' fits the other tool names, and…
- `tool.image-structure.error.other`: « Carve » stays in English because fr has no tool.carve.name yet, so the UI shows the English name. Update the reference if Carve gets a French name later.
- `tool.image-analyzer.finding.hemisphere-unknown`: '({refs} absent)' should be plural ('absents') when both GPSLatitudeRef and GPSLongitudeRef are missing. Left as is because one key covers both cases.
- `tool.image-structure.value.none`: 'aucun' is shared by Entrelacement (masculine) and Palette globale (feminine, where 'aucune' would be correct). Fixing it needs a code change, so it was left.
- `tool.piet.error.empty`: All tool.piet.* keys (and some other tools) use the straight apostrophe ', while ui.* uses ’. Not changed: it is a whole-tool style choice, and changing it would be a mass reformat.
- `tool.whitespace.*`: I used 'blancs' for trailing whitespace, as tool.esolang.error.malbolgeNotOp already does. A native speaker should confirm it reads better than keeping 'whitespace' as jargon. If you accept the two glossaryExempt entries below, the whole tool uses…
- `tool.docucolor.note.none-passes_one`: I reworded the singular form, appended to 'Parité ÉCHOUÉE (…)'. It only shows when 0 or 1 orientations were tried, which is almost impossible here.
- `tool.file-type.note.embeddedZip`: It names the tool 'Carve' in English because fr.json has no tool.carve.* keys yet. Align it once the carve tool is translated.
- `tool.file-type.col.magicLength`: 'Longueur du magic' clashes with 'magic bytes' (file-type.description) and 'octets magiques' (cat.forensics.blurb). I left it because the wording is acceptable, but a native speaker should pick one term.
- `tool.esolang.*`: These use straight ' and " quotes around code tokens ("moo", "["), while the ui.* keys use ’ and « ». I left them: about 416 of the 1137 apostrophes in fr.json are straight, spread over many tools, so this is not one outlier and fixing it means a mass…
- `tool.jwt.*`: Apostrophes do not match the ui.* convention (’) in all 58 jwt entries, the 3 text-transform entries and the 5 timestamp entries that have one; each of these tools uses the straight ' throughout. Left as is because fixing it would mean reformatting whole…
- `tool.vigenere.note.kasiski`: The IoC values 0.066 / 0.04 keep the decimal point, while printer-dots writes « 0,04 pouce ». This looks deliberate because they match the numbers the tool displays, but a native speaker may prefer 0,066.
- `tool.archive.error.notArchive`: Refers to the tools « Carve embedded files » (and Hexdump/Carve in the gap/trailing notes) by their English names, because tool.carve.name and tool.hexdump.name have no fr translation yet. Revisit once those names are translated.
- `tool.binary-analyzer.* / tool.png-surgeon.* (excluded prefixes)`: These are the only keys that address the user as vous, about 25 of them (e.g. binary-analyzer.error.blocks/dtype/number/types, hint.encrypted/fs/numeric/rawNoIso/text, note.carveCapped/hexCapped/noEmbeddedCarve_*/stringsCapped, placeholder;…
- `tool.archive.error.notArchive, tool.archive.note.gzipTrailing_one/_other, tool.archive.note.gap_one/_other, tool.auto-decode.note.file, tool.file-type.note.embeddedZip, tool.image-structure.error.other/otherSig`: These name the Carve / Hexdump tools by their English names ('Carve embedded files', 'Carve', 'Hexdump') because tool.carve.name, tool.hexdump.name and tool.entropy.name do not exist in fr yet. Re-align them once those names are written.
- `tool.text-analyzer.note.moreTokens_one/_other`: 'token' (an encoded fragment) is left as 'token(s)', while jwt uses 'jeton'. Different sense, so I left it; 'fragment' might read better.
- `tool.*.description`: Descriptions mix infinitive ('Encoder ou décoder…'), indicative/imperative ('Ouvre…', 'Décode ou construis…', 'Lis…'), and nouns. All correct French, so I did not change them (no mass reformat), but the style is inconsistent.
- `apostrophes (e.g. tool.text-analyzer.*)`: Straight ' (296) and curly ’ (535) both occur; most tools use one style, but text-analyzer mixes them across keys (23 straight, 9 curly). Left unchanged (taste / mass reformat).
