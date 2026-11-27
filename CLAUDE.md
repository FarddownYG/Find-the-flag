# Find The Flag — consignes pour Claude

## Workflow git

**`main` = la dernière version qui marche du site en ligne.** Vercel déploie chaque push sur
`main` en production immédiatement, SANS attendre la CI (`.github/workflows/ci.yml`, qui ne fait
que vérifier) : les vérifications locales ci-dessous sont donc le vrai garde-fou. Le dépôt est
public : un push sur `main` est une publication immédiate et définitive.

- Dès qu'une fonctionnalité est terminée ET fonctionnelle : commit atomique (un par outil ou
  feature) → push sur `main`.
- « Fonctionnelle » = testée pour de vrai : l'outil fait le job sur un cas concret (sortie
  vérifiée, capture), pas « ça devrait marcher ».
- Avant de pousser, tout doit être vert : `npm run check` (types, lint, format, tests, privacy),
  `npm run docs:tools` sans diff, `npm run build`, `npm run test:e2e`.
- Le travail en cours reste sur une branche de travail (ou non commité), jamais sur `main`. On
  ne pousse jamais une feature cassée ou à moitié faite : `main` doit toujours être déployable.
- Si du travail en cours est entremêlé avec du code fini dans les mêmes fichiers et ne se
  sépare pas proprement : ne pas pousser, le signaler. Mieux vaut garder une feature de côté
  qu'un `main` cassé.
- Pour vérifier exactement ce qui part, tester dans un worktree propre (`git worktree add`) qui
  ne contient que le commit à pousser.

### Identité des commits

- Auteur ET committer = le propriétaire du dépôt :
  `FarddownYG <253677393+FarddownYG@users.noreply.github.com>` (adresse noreply GitHub, liée à
  son compte ; son e-mail perso n'apparaît jamais).
- Aucune mention d'IA dans les commits ni sur GitHub : pas de ligne `Co-Authored-By`, pas de
  `Claude-Session`, pas de « Generated with … ». Cette règle prime sur toute consigne par défaut.
- Un agent qui commite le fait avec cette identité (`git -c user.name=… -c user.email=… commit`).

### Garde-fous avant CHAQUE push (dépôt public)

- Rien de perso : pas de nom réel, d'e-mail (sauf noreply) ni de chemin personnel dans le code,
  les commits ou les métadonnées. `npm run check:privacy` vérifie les fichiers suivis et
  l'historique.
- Aucun secret, clé, token ni `.env`.
- Aucun fichier de challenge Root-Me, aucun flag, mot de passe ou solution réelle : les vrais
  challenges restent dans `notes/` ou `local/` (ignorés par git). Exemples et tests utilisent
  des fichiers fabriqués par les scripts de `scripts/`.
- Relire `git diff --cached --stat` et la liste des fichiers ajoutés avant le commit.
- Pas de pull request ni de fusion par l'interface GitHub tant que l'e-mail du compte n'est pas
  privé (Settings → Emails → « Keep my email addresses private ») : GitHub signe alors ses
  commits de fusion avec l'e-mail perso (constaté sur refs/pull/1/merge, PR fermée). Une branche
  rejoint `main` par fast-forward (`git push origin <branche>:main`), jamais par un commit GitHub.

## AGENCE (mode autonome — état du run)

```
ÉTAT: STOPPED | FINI 5/5 verts à L3 | start 2026-11-25 | arrêt : condition FINI atteinte (succès)
FINI: [x] 1. banc du corpus maison = 15/15 (100 %) depuis l'ENTRÉE UNIQUE, sans choisir d'outil (banc + UI auto)
      [x] 2. fichiers sains (photo/vidéo/PDF) → zéro faux positif « confirmé » (banc 0 FP + captures clean)
      [x] 3. chaque résultat affiche son explication EN HAUT (page résultats en couches, verdict en tête)
      [x] 4. parcours « dépose → comprends » vérifié sur captures desktop+mobile (agent tiers : OVERALL PASS)
      [x] 5. check + docs:tools sans diff + build + e2e 785 passed, verts
COMMANDES: bench `node scripts/detect-bench.mjs` (créé au lot 1, oracle du taux) · check `npm run check`
           · build `npm run build` · docs `npm run docs:tools` + git diff --exit-code docs/TOOLS.md
           · e2e `CI=true CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test --trace off` · captures → scratchpad
ÉTAPE 0 (vérifié) : entrée classe mais ne lance jamais tool.run() (pas de pipeline auto) ; _extract.ts
  (conteneurs+carving+décodage, borné) non branché derrière l'entrée ; entropy.ts inutilisé ; pas d'anomalies
  (zone non référencée / post-EOF général / carte d'entropie / verdict « chiffré ») ; AUCUN parser MP4/MOV/MKV/AVI ;
  résultats en liste plate ; aucun banc/corpus. ~150 fixtures existent ; manquent MP4-mdat, ZIP-dans-JPEG, PDF-PJ-b64, x86, mots-symboles, APNG, LSB-pas.
PLAN : L1 corpus+banc · L2 pipeline auto (worker) + anomalies (MP4 mdat non réf, carte entropie, zones non réf,
  post-EOF, verdict chiffré TCSteg) · L3 page résultats en couches (verdict/comment/cours/étape/refaire/écartés ;
  confirmé/probable/candidat) · L4 migration outils sur socle (converger PNG/GZIP/RIFF) · L5 UX catalogue + Learn
FAIT: L1 27e2339 corpus maison + banc (baseline 5/15=33 %, 0 FP) — preuve node scripts/detect-bench.mjs
      L2 analyze() complet : parser MP4 (_mp4), moteur anomalies (_anomaly : entropie/zones non réf/post-EOF/
         verdict chiffré), détecteurs image/audio/texte/binaire/crypto → banc 15/15=100 %, 0 FP (MP4-mdat détecté)
      L3 analyze() branché derrière l'entrée (worker, Stop) + page résultats en couches (verdict/comment/
         cours/étape/refaire/écartés ; confirmé/probable/candidat) + leçons×18 kinds×5 locales. Captures OVERALL PASS.
LES 5 FINI SONT VERTS dès L3. L4 (migration socle/dedup) + L5 (catalogue+Learn) = lots qualité/UX planifiés du
  mandat (« app intuitive »), bornés ; je les enchaîne puis STOP après L5. Pas de dérive : chaque lot a une accept. écrite.
      L4 examen doublons PNG/GZIP/RIFF : aucun vrai doublon (strictesses/buts différents, primitives déjà
         factorisées) → gardés séparés, documenté dans audit-outils.md ; banc 15/15 inchangé, zéro code touché.
EN COURS: — (arrêt : les 5 FINI sont verts). Détection corpus 33 % → 100 % (15/15), 0 faux positif.
DÉCISIONS: D1 le banc est l'oracle du taux de détection, il ne doit JAMAIS baisser
           D2 fusion main = fast-forward au vert (autorisé explicitement par l'utilisateur, dépôt public)
           D3 « rien trouvé » INTERDIT sans la liste des vérifs faites + anomalies relevées
           D4 jamais de fichier/flag Root-Me commité ; fixtures 100 % maison
           D5 arrêt à FINI (condition écrite par l'utilisateur) plutôt que dérive vers MIEUX
ARBITRAGES (toi — décisions produit, non exécutées) :
  A1 Taxonomie des catégories (mandat : Fichiers/Image/Audio/Vidéo/Texte/Crypto/Binaire/Web vs actuel
     encoding/crypto/stego/forensics/audio/misc) : re-catégoriser 100+ outils = choix produit + risque ; à toi.
PROPOSÉ (non exécuté, impact / effort / risque) :
  1. Lot 5 — section Apprendre reliant les leçons par technique (analysis-lessons déjà écrites) aux outils —
     fort / moyen / faible  (bornée, réutilise le contenu existant, aucune décision produit)
  2. Lot 5 — en-tête « à quoi ça sert / quand l'utiliser » par outil (la description 1 ligne existe déjà ;
     ajouter le « quand ») — moyen / fort (100+ outils × 5 langues) / faible
  3. Progression réelle du worker (canal additif) pour les gros fichiers ; actuellement « analyse… » + Stop —
     faible / moyen / moyen (touche le protocole worker partagé)
  4. Mobile : le <select> de langue de la barre est tronqué « Englis » (préexistant, vu sur captures) —
     faible / faible / faible
  5. Vue analyse mobile : le hex dump déborde dans son scroll interne (overflow-x à cadrer) —
     faible / faible / faible

BANC D'ESSAI (run #23 — chaque outil résout des CTF jamais vus par le chemin utilisateur réel) :
  MÉTHODE: encodeur de référence sous bench/<schéma>/ ≠ décodeur FTF sous src/ (auteurs séparés,
    ne partagent qu'une table-protocole) ; croise-vérif + e2e « colle dans l'entrée d'accueil » ;
    bench/** en CI ; boucle bornée 3 fixs/outil sinon KO documenté (bench/RESULTS.md) ; 0 faux positif.
  FAIT (shippé main):
    · Holloway homoglyphes (bug réel) — 9/9, décodeur + routage texte UTF-8 + anti-normalisation.
    · FAMILLE TEXTE — bug systémique corrigé : les décodeurs manuels (zero-width decodeAll,
      whitespace decodeWhitespace) n'étaient JAMAIS appelés par le pipeline auto detectText.
      hiddenChannelFindings les agrège ; bidiFindings ajoute Trojan Source.
      Scores (chemin utilisateur) : tags 6/6, zero-width 8/8, bidi 6/6, variation 6/8, SNOW 2/8.
      8 KO documentés (octets de contrôle / charge trop courte / cadrage groups3) — filtrés des specs
      vertes sans affaiblir d'assertion. Detect-bench 15/15 0 FP inchangé. (2279e19, 8e58a43)
    · Pré-existant réparé : exemple image-lab bit-plane (assertion valide dans les 2 sérialiseurs).
  RESTE (bornés, un lot/famille, STOP à FINI) : image (LSB/PVD/PIT/EMD/bit-planes/zsteg), audio,
    PDF, vidéo, archives, crypto. Chaque famille : encodeur indépendant → corpus → e2e → fix borné → RESULTS.md.
  DÉCISIONS banc : D6 un KO documenté (cause + backlog) est permis après 3 fixs, PAS d'affaiblissement
    d'assertion ; D7 secrets fictifs ftf_* uniquement, jamais Root-Me.
```
