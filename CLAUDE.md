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

## AGENCE (mode autonome — état du run)

```
ÉTAT: RUNNING | cycle 0/14 | sans-gain 0/2 | start 2026-10-15T10:30Z | budget 12 familles d'outils, 4 vagues
FINI: [ ] portes vertes sur HEAD de autonome/2026-10-15 (check, docs:tools sans diff, build, e2e complet)
      [ ] vague 1 intégrée : playfair, bifid, hill, adfgvx, columnar, nihilist, enigma (vecteurs publiés verts)
      [ ] vague 2 : codes-barres 1D/2D, pack d'encodages, alphabets de symboles
      [ ] vague 3 : SSTV, analyseur PDF, lecteur SQLite
      [ ] vague 4 : stégano WAV LSB, analyseur ELF/PE, identificateur de chiffre
      [ ] check:privacy propre, commits FarddownYG noreply sans mention d'IA
COMMANDES: npm run check · npm run docs:tools + git diff --exit-code docs/TOOLS.md · npm run build
           · e2e : build → vite preview → playwright (worktree propre) · captures → scratchpad (hors git)
FAIT: 072a021 base de départ — check 3730 tests verts, e2e 355 passed, CI verte
EN COURS: vague 1 (3 agents en worktree isolé, chacun commite dans sa branche, intégration par moi)
SUIVANT: vague 2 dès qu'un slot se libère
DÉCISIONS: D1 un agent = une famille, commit dans son worktree isolé ; seul l'orchestrateur intègre
           (cherry-pick + portes complètes) — rouvrir si une intégration casse main
ARBITRAGES: A1 fusion autonome/2026-10-15 → main (= mise en prod Vercel) : le skill interdit le push
           main en autonome, la règle « Workflow git » ci-dessus dit de pousser chaque outil fini.
           Reco : fusionner par lots de vague, après relecture des captures.
PROPOSÉ: (rempli en fin de run)
```
