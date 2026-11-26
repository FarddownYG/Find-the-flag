# Audit des outils — socle commun & extracteur universel

Phase 1 (lecture seule). 101 outils, 6 catégories. But : de bons outils qui couvrent des
**familles** de cas, un socle partagé, et un extracteur universel récursif. Rien ne quitte le
navigateur.

## Résumé

FTF a **déjà un socle solide** : entrée unifiée, décodage image/audio exact, workers avec
annulation, union de sorties avec routage « ouvrir dans l'outil X », détection de flags, et même
une recherche en faisceau de chaînes de décodeurs (`auto-decode`). Le vrai manque n'est pas un
socle à créer de zéro, mais :

1. **un registre de décodeurs partagé** (aujourd'hui enfermé dans `auto-decode.ts`) ;
2. **une interface commune « conteneur → enfants »** pour que les parsers (PDF, ZIP, PNG, ELF…)
   soient appelables par un orchestrateur ;
3. **l'extracteur universel** (récursif : conteneurs + carving + décodage auto) — la vraie
   valeur neuve ;
4. quelques **duplications** à résorber (base64 réimplémenté 4×, limites de taille `MAX_*`
   éparpillées, recouvrements d'analyseurs).

Les ~17 chiffres classiques et la plupart des encodages sont **déjà bien factorisés** — on garde.

## Socle existant (`src/core/`)

| Module                                        | Rôle                                                                                     | Couvre la demande Phase 3 ?                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `prepare.ts`                                  | Entrée unifiée text/bytes/image/audio/file, `LazyFile` (lecture paresseuse)              | Oui (entrée unique)                                                  |
| `decode-image.ts`                             | PNG/BMP/**Netpbm** exact en JS, fallback navigateur JPEG/GIF/WebP                        | Oui (aperçu image)                                                   |
| `decode-audio.ts`, `wav.ts`, `audio-rate.ts`  | WAV + codecs navigateur                                                                  | Oui (aperçu audio)                                                   |
| `runner.ts`, `worker.ts`, `worker-handler.ts` | Exécution en Web Worker, **annulation** du run précédent                                 | Partiel : worker + annulation OK, **barre de progression à ajouter** |
| `types.ts` (`Output`)                         | Union de sorties : text/bytes/table/kv/image/picture/audio/files/map/**actions(open)**/… | Oui : **« pistes suivantes » existent déjà** (`actions.open`)        |
| `flags.ts`                                    | Détection de formats de flag                                                             | Oui                                                                  |
| `define.ts`, `registry.ts`, `tool-list.ts`    | Déclaration d'outil, registre, glob                                                      | —                                                                    |
| `result-text.ts`                              | Rendu des sorties en texte (tests)                                                       | —                                                                    |

**UI** (`src/ui/app.ts`) : glisser-déposer déjà géré. À vérifier/compléter : coller, URL de
données, barre de progression du worker.

## État des préoccupations de duplication

| Préoccupation               | État actuel                                                                                                               | Verdict                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Chargement de fichier       | Centralisé (`prepare.ts` + `LazyFile`)                                                                                    | OK, garder                                                                                       |
| Détection de format (magic) | `_binary-identify.ts` partagé (file-type, binary-analyzer, carve)                                                         | **Généraliser** : vérifier qu'il valide l'en-tête (pas 2 octets) et l'exposer comme module socle |
| Vue hexa                    | `hexdump` + `_binary-hex.ts`                                                                                              | Quasi centralisé — exposer comme composant réutilisable                                          |
| Décodeurs                   | Jeu complet mais **enfermé dans `auto-decode.ts`** (beam search récursif base64/32/58/85, hex, binary, URL, gzip, ROT13…) | **Extraire** en `_decoders.ts` partagé (socle)                                                   |
| Workers + progression       | Worker + annulation OK, **pas de primitive de progression**                                                               | Ajouter une progression dans le socle                                                            |
| Limites de taille           | `MAX_*` déclarées **localement** (10× `MAX_BYTES`, 8× `MAX_SIZE`, 7× `MAX_PIXELS`…)                                       | **Centraliser** les communes dans le socle                                                       |
| base64 / atob               | Réimplémenté dans `jwt`, `hash`, `web-source`, `js-deobfuscate`                                                           | **Corriger** : utiliser le décodeur partagé                                                      |

## Tableau par outil (verdict)

Légende : **G** garder · **S** → socle (migrer/exposer) · **F** fusionner · **E** étendre/généraliser.

### encoding (25) — façades fines sur des codecs

Tous **G**, mais les codecs doivent alimenter le **registre `_decoders.ts`** (S) pour `auto-decode`
et l'extracteur : base32/36/45/58/62/85/91/100, base64, hex, binary, braille, bubblebabble,
punycode, uuencode, quoted-printable, html-entities, unicode-escape, url, charcode, morse, nato,
phone-keypad, base-convert. `auto-decode` : **E** (déplacer son moteur dans le socle).

### crypto (27) — bien factorisé (`_classical.ts`, `_fitness.ts`)

G : adfgvx, affine, atbash, bacon, bifid, caesar, columnar, enigma, hill, nihilist, playfair,
polybius, rail-fence, substitution, symbol-ciphers, symbol-words, vigenere, frequency,
cipher-identify, hash, hash-identify, hash-extender, jwt, rsa, modcalc, symmetric, xor.
Actions : `jwt`/`hash` → base64 partagé (S). `cipher-identify` : déjà routeur « open » (modèle à
suivre).

### forensics (16) — le cœur du recouvrement

- **binary-analyzer** (G/E) : agrège déjà hexa, scan, identify, overview — proche de l'extracteur ;
  devient le socle d'inspection « fichier inconnu ».
- **exe-analyzer** (G) : ELF/PE/Mach-O + nouvel onglet encodage ; parser conteneur réutilisable.
- **pdf-analyzer** (E) : à mener jusqu'au bout (object streams, /EmbeddedFile+/Filespec, post-%%EOF)
  — fournira des enfants à l'extracteur.
- **carve** (G/S) : moteur de carving par signatures → réutilisé par l'extracteur.
- **file-type** (S) : exposer `_binary-identify` comme module socle.
- **archive** (G) : ZIP/tar/gz → parser conteneur.
- **sqlite**, **pcap** (G) : parsers conteneurs spécialisés.
- **entropy, hexdump, strings** (S) : primitives réutilisables (vues).
- web-source (G, base64→partagé S), js-deobfuscate (G, base64→S), php-audit, script-decode,
  xss-workshop (G).

### stego (20) — partagent `decode-image`

G majoritaire. Recouvrements à examiner (F candidat) :

- **image-structure** ↔ **image-analyzer** ↔ **png-surgeon** (parsing PNG/JPEG/GIF) → parser
  conteneur image commun.
- **docucolor** ↔ **printer-dots** (points de traçage imprimante) → fusion possible.
- **channel-reveal** ↔ **color-inspector** ↔ **bit-planes** ↔ **lsb** ↔ **emd** : techniques
  distinctes, faible dup de code → G.
- barcode, barcode-pattern, qr, metadata, image-combine, text-analyzer, unicode-hidden,
  whitespace, zero-width, basen-padding → G.

### audio (6) — partagent `decode-audio`

G : audio-stego, audio-lab, dtmf, morse-audio, spectrogram, sstv.

### misc (7)

G : ascii-table, esolang, number-base, piet, text-transform, timestamp, whitespace-lang.
`number-base` ↔ `base-convert` (encoding) : recouvrement léger → examiner (F candidat).

## Recouvrements & conteneurs pour l'extracteur

Parsers conteneurs déjà présents à réutiliser (Phase 4) : **PDF** (pdf-analyzer), **ELF/PE/Mach-O**
(exe-analyzer), **PNG/APNG** (png-surgeon), **image PNG/JPEG/GIF** (image-structure), **ZIP/tar/gz**
(archive), **SQLite** (sqlite), **PCAP** (pcap), **carving** (carve), **signatures**
(_binary-identify). L'extracteur les orchestre via une interface commune `parse(bytes) → nœuds`.

## Plan ordonné

**Phase 2 — filet de sécurité.** La plupart des outils ont déjà des tests maison (`*.test.ts`).
Action : vérifier la couverture des outils qui vont bouger (binary-analyzer, carve, auto-decode,
file-type, pdf-analyzer, image-structure/analyzer, docucolor/printer-dots) et compléter les cas
« golden » manquants. Verts avant/après chaque lot.

**Phase 3 — socle commun** (ce qui manque vraiment) :

- `_decoders.ts` : registre de décodeurs extrait d'`auto-decode` (base64/32/85, hex, URL,
  gzip/zlib/deflate, XOR mono-octet ; bz2/xz en WASM **si** licence/taille OK — sinon backlog).
- `_signatures.ts` : exposer `_binary-identify` (vérif en-tête, extensible).
- primitive de progression worker + limites de taille centralisées.

**Phase 4 — extracteur universel** : arbre récursif (conteneurs + carving validé « confirmé vs
candidat » + décodage auto des blobs texte), profondeur + taille cumulée bornées (anti zip-bomb),
nœuds avec type/offset/taille/chemin/aperçu/download/open-in-tool, flags en avant.

**Phase 5 — fusions par lots (6 max cette session)** :

1. `_decoders.ts` + rebrancher `auto-decode` (golden verts).
2. base64 partagé (jwt, hash, web-source, js-deobfuscate) + limites `MAX_*` centralisées.
3. `_signatures.ts` exposé + `file-type`/`carve` rebranchés.
4. **Extracteur universel** (sur le socle).
5. Fusion `image-structure` ↔ `image-analyzer` (parser conteneur image) **ou** `docucolor` ↔
   `printer-dots`.
6. Réserve : seconde fusion ou polissage extracteur.
   Puis **STOP** + backlog ici-même (bz2/xz WASM, autres fusions, progression UI).

## Backlog (reporté)

- Décompression bz2/xz en WASM (licence + taille à vérifier, comme iced-x86).
- `number-base` ↔ `base-convert` : unifier ou documenter la différence.
- Barre de progression worker dans l'UI pour les gros fichiers (primitive de progression du socle Phase 3, non faite).
- Revue des 10 stégano image pour une éventuelle vue unifiée « plans/canaux ».

## Examen des candidats de fusion (Phase 5) et des limites `MAX_*`

Verdict : **aucun code modifié**, les quatre outils restent séparés.

- **`image-structure` ↔ `image-analyzer`** : le parsing des conteneurs est déjà mutualisé. Les deux
  s'appuient sur les parseurs partagés `_png`, `_jpeg`, `_gif` ; `image-analyzer` réutilise déjà
  `describeTail` d'`image-structure`. Ce qui reste distinct n'est pas du parsing dupliqué :
  `image-structure` fait la chirurgie/réparation (IHDR, chunks, extraction de fichiers), alors que
  `image-analyzer` fait la synthèse (métadonnées EXIF/XMP/IPTC, vignette, régions, chaînes). Un
  module commun n'enlèverait presque aucune ligne.
- **`docucolor` ↔ `printer-dots`** : déjà en couches. `_docucolor.ts` est le codec de la matrice
  15 × 8 (colonnes, parité, orientations) ; `printer-dots` est la vision (détection des points,
  réseau, recherche de fenêtres) et réutilise `orient`/`ORIENTATIONS` de `_docucolor`. Aucune
  logique dupliquée à extraire.
- **Limites `MAX_*`** : les noms se répètent mais pas les valeurs ni le sens. `MAX_PIXELS` vaut
  30 M (`pit`, `pvd`), 40 M (`_piet-core`) ou 60 M (`_image-analyzer-thumb`) ; `MAX_BYTES` vaut
  256 MiB (`_extract`), 128 MiB (`_sqlite-run`) ou 40 MiB (`_web-source-fetch`) ; 256 MiB apparaît
  pour des raisons différentes (`audio-stego` fichier lu entier, `_extract` budget d'octets, `_zip`
  sortie décompressée). Aucune valeur n'est partagée à l'identique par 3 outils pour la même
  raison : pas de `src/core/limits.ts` créé, centraliser forcerait des couplages artificiels. À
  rouvrir si un 3ᵉ outil reprend 30 M pixels (`pit`/`pvd`) ou 256 MiB « fichier lu entier ».
- **Primitive de progression worker** : reste au backlog (changement UI/worker plus large).

## Examen des parseurs en double (Lot 4) : aucun code modifié

Verdict : les trois paires restent séparées. Chaque boucle ressemble à sa voisine par sa forme
(lire un en-tête, avancer d'une taille), mais ce qui la rend utile est exactement ce qui diffère ;
un itérateur commun devrait être paramétré sur tous ces points, pour moins de lignes retirées que
de lignes de configuration ajoutées, avec le risque de changer un parseur qui passe le banc de
détection (15/15, 0 faux positif).

- **PNG : `_png.parsePng` ↔ `_png-surgeon-parse.parseTolerant`.** `parsePng` est strict : il
  s'arrête au premier chunk invalide et le signale (`problem`). `parseTolerant` ne s'arrête
  jamais : resynchronisation par balayage (CRC valide, sinon type connu), réparation de type,
  trous (`gaps`), données après IEND, IHDR renommé. Ce qu'ils partagent se limite à la lecture
  d'un en-tête de 8 octets et au CRC, déjà mutualisés (`u32be`, `crc32`). La boucle de marche
  n'a pas de logique commune : un lecteur partagé devrait soit réimplémenter l'un des deux
  comportements dans l'autre, soit exposer des rappels pour chaque décision.
- **GZIP : `_extract.ts` ↔ `archive.ts` (`readGzipMember`).** `_extract` ne lit pas
  d'en-tête gzip : il passe les octets à `Gunzip` (fflate) en flux avec un plafond de sortie
  (`inflateBounded`) et ne voit qu'un nœud « inflate ». `archive.ts` analyse l'en-tête (FEXTRA,
  nom, commentaire, FHCRC), localise la fin du flux deflate (`deflateScan`), vérifie CRC32/ISIZE
  et enchaîne les membres. Aucun code de marche en double ; la détection de signature est déjà
  `isGzip` (`encoding/_inflate`). Rien à extraire.
- **RIFF/WAV : `core/wav.scanWav` ↔ `audio/_audio-stego-pcm.walkChunks`
  (`_audio-stego-riff.analyzeChunks` consomme déjà le résultat de `walkChunks`, pas de
  troisième marche).** `scanWav` (cœur, utilisé par le décodeur) ignore la validité des
  identifiants, ne s'arrête pas sur un dépassement, lit `fmt ` (dont WAVE_FORMAT_EXTENSIBLE) et
  s'arrête au premier `data`. `walkChunks` couvre aussi AIFF (big-endian), rejette les
  identifiants invalides, s'arrête sur une taille qui sort du fichier (sauf `data`/`SSND`) et
  rend tous les chunks, `declaredEnd` et `stop` pour la stégo. Terminaisons incompatibles ; et
  `core/` ne doit pas importer depuis `tools/`. À rouvrir si un 3ᵉ outil réécrit la même marche
  avec les mêmes règles d'arrêt.
