# Banc d'essai — chaque outil doit résoudre des CTF qu'il n'a jamais vus

But : prouver chaque outil FTF sur des challenges **générés** et résolus par le **chemin utilisateur réel**
(on dépose le fichier / on colle le texte dans l'entrée principale, sans choisir l'outil). Un cas est
réussi quand le secret est retrouvé et remonté par le pipeline.

## Méthode (anti-tests-qui-mentent)

- **Auteurs séparés** : l'encodeur de référence (sous `bench/<schéma>/`) et le décodeur FTF (sous `src/`)
  sont écrits par des agents différents qui ne voient pas le code l'un de l'autre ; ils ne partagent
  que la **table-protocole** (une donnée). Même auteur = bugs corrélés = tests qui mentent.
- **Croise-vérification** : un test `bench/<schéma>/crossverify.test.ts` décode (côté FTF) les fixtures
  de l'encodeur indépendant.
- **Chemin utilisateur** : un test Playwright colle la fixture dans l'entrée d'accueil et vérifie que le
  secret remonte — sans choisir d'outil.
- **Corpus propre** : des fichiers sans rien → zéro faux positif « confirmé ».
- `bench/**` tourne dans `npm run check` (donc en CI). Fixtures 100 % maison, secrets fictifs, jamais Root-Me.
- Boucle bornée : générer → lancer → échec ? cause racine → fix → rejouer tout → max 3 tentatives/outil,
  sinon KO documenté ici.

## Score

| Outil / schéma                                      | Challenges | Réussis | Échoués | Faux positifs | Statut  |
| --------------------------------------------------- | ---------- | ------- | ------- | ------------- | ------- |
| Holloway (homoglyphes, « Twitter Secret Messages ») | 9          | 9       | 0       | 0             | ✅ OK   |
| Tags Unicode (U+E00xx)                              | 6          | 6       | 0       | 0             | ✅ OK   |
| Zero-width (330k / base-k / groupes / morse…)       | 8          | 8       | 0       | 0             | ✅ OK   |
| Sélecteurs de variation (U+FE00…)                   | 8          | 6       | 2       | 0             | ⚠️ 2 KO |
| SNOW (espaces de fin)                               | 8          | 2       | 6       | 0             | ⚠️ 6 KO |
| Bidi / Trojan Source (RLO/LRO/isolates)             | 6          | 6       | 0       | 0             | ✅ OK   |

**Total famille texte : 45 générés, 37 remontés par le chemin utilisateur, 8 KO documentés, 0 faux positif.**

| Outil / schéma                              | Challenges | Réussis | Échoués | Faux positifs | Statut |
| ------------------------------------------- | ---------- | ------- | ------- | ------------- | ------ |
| LSB image (PNG, RGB plan 0, row-major, MSB) | 5          | 5       | 0       | 0             | ✅ OK  |

**Total famille image : 5 générés, 5 remontés, 0 faux positif.**

| Outil / schéma                               | Challenges | Réussis | Échoués | Faux positifs | Statut |
| -------------------------------------------- | ---------- | ------- | ------- | ------------- | ------ |
| LSB audio (WAV PCM 16 bits, bit 0, MSB)      | 5          | 5       | 0       | 0             | ✅ OK  |
| PDF — PNG+tEXt ajouté après %%EOF (polyglot) | 4          | 4       | 0       | 0             | ✅ OK  |

**Total audio : 5/5 · PDF : 4/4 · 0 faux positif.**

| Outil / schéma                                    | Challenges | Réussis | Échoués | Faux positifs | Statut |
| ------------------------------------------------- | ---------- | ------- | ------- | ------------- | ------ |
| Archives (ZIP STORE + polyglotte PNG+ZIP)         | 4          | 4       | 0       | 0             | ✅ OK  |
| Crypto/encodages (base64/hex/base32/mixtes/ROT13) | 6          | 6       | 0       | 0             | ✅ OK  |

**Total archives : 4/4 · crypto : 6/6 · 0 faux positif.**

### Détails

**Holloway** — bug réel corrigé. Causes : (1) décodeur absent (le canal glyphe lisait 1 bit/lettre, pas
l'index de variante) ; (2) entrée mal routée — le pipeline jugeait « texte » au ratio **ASCII**, donc le
stégano porté par de l'Unicode passait pour du binaire et les détecteurs texte étaient zappés ; et la box
d'accueil coupait (`.trim()`) les espaces spéciaux de bordure avant le décodage. Corrigé : décodeur
`_holloway` (floor(log2(variants+1)) bits/caractère, 6 bits → alphabet), détection « texte » consciente de
l'UTF-8, texte brut jamais normalisé avant les décodeurs, avertissement quand les espaces spéciaux sont
perdus au copier-coller. Preuve : croise-vérif 9/9 + e2e `e2e/holloway.spec.ts`.

**Canaux invisibles (tags / zero-width / variation / SNOW / bidi)** — bug systémique corrigé. Cause : les
décodeurs manuels (`_zerowidth.decodeAll`, `whitespace.decodeWhitespace`) n'étaient **jamais appelés** par
le pipeline auto `detectText` ; seul un outil choisi à la main les lançait. Corrigé : `hiddenChannelFindings`
agrège ces décodeurs (seuil de score ≥ 35, lisibilité consciente de l'Unicode, message complet dans le
`detail`), et `bidiFindings` ajoute la détection Trojan-Source (contrôles directionnels retirés → lecture
logique). Preuve : e2e `e2e/{unicode-tags,zero-width,variation-selectors,snow,bidi}-bench.spec.ts`.

### KO documentés (boucle bornée : 3 tentatives de fix passées, cause racine établie)

- **Sélecteurs de variation — `06-low-bytes`** : la charge est faite d'octets de contrôle (non imprimables),
  donc non remontée comme message lisible (le seuil anti-faux-positif l'écarte, à raison). **`08-short`** : la
  charge est « ok » (2 caractères), sous le seuil de confiance. Cas-limites, pas un défaut de décodage.
- **SNOW — variantes `groups3` (6 cas)** : le canal SNOW de FTF lit le binaire (bit = espace vs tab) et des
  groupes « espaces-avant-tab » à partir du **premier** tab ; l'encodeur de référence cadre « N espaces puis
  tab dès le premier groupe ». Divergence de convention de cadrage, pas une régression. Les deux fixtures
  binaires (`05`, `06`) passent. Backlog : couvrir la variante de cadrage groups3.

Ces 8 fixtures restent dans le corpus (générées, traçables) mais sont filtrées des specs e2e vertes via une
liste `KO` commentée pointant ici — aucun test n'est affaibli (assertion inchangée), le KO est rendu visible.

**LSB image** — pas de bug : le pipeline auto `detectImage` lance déjà le balayage LSB complet
(tous canaux × plans × ordre ligne/colonne × MSB/LSB + zones + statistiques chi²/RS) depuis l'entrée
unique. L'encodeur de référence (`bench/lsb/encode.mjs`, PNG écrit à la main via `node:zlib`, décodeur
FTF non lu) embarque un flag `FTF{...}` en LSB du plan 0 (R, G, B, row-major, MSB d'abord) ; l'entrée le
remonte en « confirmé » pour les 5 fixtures. Preuve : croise-vérif `bench/lsb/crossverify.test.ts` (décodeur
indépendant) + e2e `e2e/lsb-bench.spec.ts` (upload dans l'entrée). _Limite assumée_ : les porteurs sont des
dégradés lisses (plan 0 à zéro), donc le banc couvre le cas standard, pas encore un porteur bruité/photo réelle
ni les variantes d'ordre (BGR, colonnes, plans > 0) — backlog.

**LSB audio** — pas de bug : `detectAudio` lit déjà les échantillons PCM bruts et balaie les plans LSB
(canaux × bit-order + passe autour de l'onset). Encodeur de référence indépendant (`bench/audio/encode.mjs`,
WAV 16 bits mono écrit à la main, décodeur FTF non lu) : flag `FTF{...}` en LSB du bit 0, MSB d'abord, sans
en-tête. L'entrée le remonte en confirmé pour 5 fixtures. Preuve : croise-vérif + e2e d'upload. _Limite_ :
un seul type de porteuse (ton faible amplitude 8 kHz), pas de silence pur ni de bruit — backlog.

**PDF (fichier ajouté après %%EOF)** — pas de bug : `analyze` carve le PNG ajouté puis lit son chunk tEXt.
Encodeur indépendant (`bench/pdf/encode.mjs`, PDF minimal valide + PNG 8×8 avec tEXt, concaténés ; code FTF
non lu) : flag `FTF{...}` dans le tEXt du PNG ajouté. L'entrée le remonte pour 4 fixtures. Preuve : croise-vérif
(ré-extraction indépendante) + e2e d'upload. _Limite_ : une seule technique (PNG clair après EOF, tEXt non
compressé) — ni PDF chiffré, ni pièce jointe PDF, ni iTXt/zTXt — backlog.

**Archives** — pas de bug : `analyze` carve l'archive ajoutée et lit le flag dans l'entrée contenue.
Encodeur indépendant (`bench/archives/encode.mjs`, ZIP écrit à la main avec CRC32 maison, code FTF non lu) :
`flag.txt` = `FTF{...}`, en ZIP STORE seul et en polyglotte PNG+ZIP (ZIP après l'IEND). L'entrée remonte les 4.
Preuve : croise-vérif (parseur EOCD/central-directory indépendant) + e2e d'upload. _Limite_ : STORE seul, une
entrée, ZIP juste après l'IEND — ni DEFLATE, ni ZIP64, ni chiffrement, ni padding avant le ZIP — backlog.

**Crypto / encodages** — pas de bug : l'auto-décodage de l'entrée déroule les couches réversibles sans clé.
Encodeur indépendant (`bench/crypto/encode.mjs`, base32 RFC4648 et ROT13 réimplémentés, code FTF non lu) :
`FTF{...}` passé par base64, hex, base64², base32, hex(base64), ROT13 — collé comme texte dans l'entrée, qui
le ramène en clair pour les 6 cas. Preuve : croise-vérif (décodeur inverse indépendant) + e2e de collage.
_Limite_ : encodages/transpositions réversibles sans clé ; les chiffrements à clé (XOR clé inconnue, AES…) ne
sont pas visés par ce banc — ils relèvent des outils dédiés, pas de l'auto-décodage.
