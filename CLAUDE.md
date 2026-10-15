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
ÉTAT: STOPPED | cycle 12/14 | sans-gain 0/2 | start 2026-10-15T10:30Z | fin : tous les critères FINI verts
FINI: [x] portes vertes sur HEAD de autonome/2026-10-15 (check 5463 tests, docs:tools sans diff,
          build, e2e 660 passed)
      [x] vague 1 : playfair, bifid, hill, adfgvx, columnar, nihilist, enigma
      [x] vague 2 : barcode (+ barcode-pattern), 9 encodages, symbol-ciphers
      [x] vague 3 : sstv, pdf-analyzer, sqlite
      [x] vague 4 : audio-stego, exe-analyzer, cipher-identify
      [x] check:privacy propre, commits FarddownYG noreply sans mention d'IA
COMMANDES: npm run check · npm run docs:tools + git diff --exit-code docs/TOOLS.md · npm run build
           · e2e : build → vite preview → playwright (worktree propre) · captures → scratchpad (hors git)
FAIT: 65 → 90 outils, chacun vérifié contre une référence indépendante (vecteurs publiés recalculés
      en Python, py-enigma, PySSTV, poppler, sqlite3, readelf / pefile, Python wave / binascii)
      6087893 fix(ui) removeChild quand un menu change avec une option texte focus (réentrance)
DÉCISIONS: D1 un agent = une famille, commit dans son worktree isolé ; seul l'orchestrateur intègre
           (cherry-pick + portes complètes) — rouvrir si une intégration casse main
           D2 fusion vers main = fast-forward depuis autonome/ (pas de PR, voir garde-fou e-mail)
           D3 pas de table de symboles inventée (Templar, Dancing Men) sans source vérifiable
ARBITRAGES: A1 tranché (« go ») : main avancé en fast-forward sur autonome/2026-10-15 le 2026-10-15,
           25 outils mis en production.
PROPOSÉ (non exécuté, impact / effort / risque) :
  1. Barre du haut en russe 9 px trop large sur mobile (vue par l'agent exe-analyzer) — moyen / faible / faible
  2. qr.test.ts dépasse son budget de 15 s sous charge (vu 4 fois) — moyen / faible / faible
  3. Liens croisés : symbol-ciphers → braille, frequency → cipher-identify, text-analyzer sur la
     table confusables d'Unicode — moyen / moyen / faible
  4. CI : actions/checkout et setup-node v4 tournent sur Node 20 déprécié → v5 — faible / faible / faible
  5. Templar, Dancing Men, runes dès qu'une table de référence vérifiable est disponible — moyen / moyen / moyen
```
