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

| Outil / schéma | Challenges | Réussis | Échoués | Faux positifs | Statut |
| --- | --- | --- | --- | --- | --- |
| Holloway (homoglyphes, « Twitter Secret Messages ») | 9 | 9 | 0 | 0 | ✅ OK |

### Détails

**Holloway** — bug réel corrigé. Causes : (1) décodeur absent (le canal glyphe lisait 1 bit/lettre, pas
l'index de variante) ; (2) entrée mal routée — le pipeline jugeait « texte » au ratio **ASCII**, donc le
stégano porté par de l'Unicode passait pour du binaire et les détecteurs texte étaient zappés ; et la box
d'accueil coupait (`.trim()`) les espaces spéciaux de bordure avant le décodage. Corrigé : décodeur
`_holloway` (floor(log2(variants+1)) bits/caractère, 6 bits → alphabet), détection « texte » consciente de
l'UTF-8, texte brut jamais normalisé avant les décodeurs, avertissement quand les espaces spéciaux sont
perdus au copier-coller. Preuve : croise-vérif 9/9 + e2e `e2e/holloway.spec.ts`.
