/**
 * About 5000 frequent French word forms, most frequent first (rank = position).
 * Hand-written from general knowledge of word frequency, not copied from a licensed list;
 * the order is approximate, which is enough for log-rank scoring. Lowercase, accents kept.
 * Elided forms (l', d', qu') are handled by the tokenizer in ../readability.ts.
 */
export const FR_WORDS = `de la le et les des en un à une du est que il pas qui pour dans a sur au
ne se plus par ce je on avec son elle sa mais vous nous ou sont ses être comme tout aux y lui été
cette fait bien ont leur ils même aussi deux sans peut très faire où avait était si dont nos entre
elles ces moi mon me votre encore autres sous ma notre leurs tous alors après bon contre avoir
fois ni rien depuis donc autre dit toute avant temps ça peu cela non quand jamais jour toujours
ans chose puis car grand trop quelque déjà dire vie trois homme suis moins sera mes ici moment tu
te toi ta tes ton celle celui ceux celles lequel laquelle lesquels quoi oui voilà chez vers ainsi
pendant tant parce selon aujourdhui tellement assez beaucoup étaient es sommes êtes étais étions
étiez serai seras serons serez seront serais serait serions seriez seraient sois soit soyons soyez
soient fus fut fûmes furent fût étant ai as avons avez avais avions aviez avaient aurai auras aura
aurons aurez auront aurais aurait aurions auriez auraient aie aies ait ayons ayez aient eu eue eus
eut eurent eût ayant vais vas va allons allez vont allais allait allions alliez allaient irai iras
ira irons irez iront irais irait irions iriez iraient aille ailles aillent allé allée allés allées
alla allèrent aller allant fais faisons faites font faisais faisait faisions faisiez faisaient
ferai feras fera ferons ferez feront ferais ferait ferions feriez feraient fasse fasses fassions
fassiez fassent fit firent faite faits faisant dis disons dites disent disais disait disions
disiez disaient dirai diras dira dirons direz diront dirais dirait dirions diriez diraient dise
dises dite dits disant peux pouvons pouvez peuvent pouvais pouvait pouvions pouviez pouvaient
pourrai pourras pourra pourrons pourrez pourront pourrais pourrait pourrions pourriez pourraient
puisse puisses puissions puissiez puissent pu put purent pouvoir pouvant veux veut voulons voulez
veulent voulais voulait voulions vouliez voulaient voudrai voudras voudra voudrons voudrez
voudront voudrais voudrait voudrions voudriez voudraient veuille veuillez veuillent voulu voulue
voulut vouloir voulant sais sait savons savez savent savais savait savions saviez savaient saurai
sauras saura saurons saurez sauront saurais saurait saurions sauriez sauraient sache saches
sachions sachiez sachent su sue sut savoir sachant vois voit voyons voyez voient voyais voyait
voyions voyiez voyaient verrai verras verra verrons verrez verront verrais verrait verrions
verriez verraient voie voies vu vue vus vues vit virent voir voyant dois doit devons devez doivent
devais devait devions deviez devaient devrai devras devra devrons devrez devront devrais devrait
devrions devriez devraient doive doives dû due dus dues dut durent devoir devant viens vient
venons venez viennent venais venait venions veniez venaient viendrai viendras viendra viendrons
viendrez viendront viendrais viendrait viendrions viendriez viendraient vienne viennes venu venue
venus venues vint vinrent venir venant voici allô bonjour bonsoir merci pardon salut adieu femme
enfant an année monde main pays maison ville clé message tête père mère fils fille frère sœur ami
amie mari parent famille gens personne histoire nom côté porte yeux œil corps cœur voix mot nuit
matin soir heure minute semaine mois siècle guerre paix travail argent place point fin début
raison idée question réponse problème cas exemple partie part façon manière sorte genre ordre
force forme effet lieu terre eau air feu ciel mer soleil lune étoile rue route chemin pied bras
jambe dos visage bouche nez oreille cheveux peau sang âme esprit dieu roi reine prince loi droit
état gouvernement président ministre politique parti peuple nation république société groupe
public service bureau école classe élève maître professeur livre lettre papier page journal
article image photo film musique chanson art théâtre jeu sport équipe match chambre salle table
chaise lit fenêtre mur toit jardin arbre fleur herbe bois forêt champ montagne rivière fleuve lac
île plage côte pierre sable neige pluie vent froid chaleur lumière ombre couleur bruit silence
odeur goût regard pensée sentiment amour peur joie douleur plaisir envie besoin désir espoir rêve
souvenir mémoire vérité mensonge secret mystère sens cause but projet plan action acte geste
mouvement voyage départ retour arrivée entrée sortie moitié milieu bout fond bord haut bas
derrière dessus dessous dedans dehors autour près loin ailleurs partout nulle bonne bons bonnes
grande grands grandes petit petite petits petites nouveau nouvelle nouveaux nouvelles vieux
vieille vieilles jeune jeunes beau belle beaux belles bel mauvais mauvaise gros grosse long longue
longs longues haute hauts hautes basse premier première premiers premières dernier dernière
derniers dernières seul seule seuls seules mêmes tel telle tels telles certain certaine certains
certaines plusieurs chaque quelques aucun aucune nul toutes propre vrai vraie faux fausse plein
pleine vide simple facile difficile possible impossible nécessaire important importante blanc
blanche noir noire rouge bleu bleue vert verte jaune gris grise brun brune rose clair claire
sombre chaud chaude froide doux douce dur dure fort forte faible lourd lourde léger légère rapide
lent lente libre heureux heureuse malheureux triste content contente gentil gentille méchant fou
folle sage riche pauvre cher chère pareil pareille général générale particulier particulière
publique privé privée national nationale international internationale social sociale économique
humain humaine naturel naturelle personnel personnelle entier entière différent différente
prochain prochaine ancien ancienne moderne vivant mort morte âgé âgée malade sûr sûre prêt prête
profond profonde large étroit sec sèche mouillé sale calme tranquille terrible horrible magnifique
superbe immense énorme minuscule étrange bizarre curieux curieuse sérieux sérieuse drôle célèbre
inconnu inconnue connu fier fière mal mieux pire autant presque environ seulement surtout souvent
parfois quelquefois longtemps bientôt tard tôt maintenant hier demain ensuite enfin là ensemble
vite lentement doucement vraiment simplement certainement évidemment naturellement absolument
complètement totalement exactement justement probablement sûrement heureusement malheureusement
finalement également notamment rapidement facilement directement immédiatement réellement
entièrement parfaitement largement autrement plutôt cependant pourtant néanmoins toutefois or
sinon puisque lorsque tandis pourquoi comment combien auquel duquel desquels auxquels parmi malgré
durant envers hors outre sauf voire dès jusque jusqu eux soi vos cet ceci quel quelle quels
quelles lesquelles chacun chacune quelqu quelquun autrui quatre cinq six sept huit neuf dix onze
douze treize quatorze quinze seize vingt trente quarante cinquante soixante cent cents mille
million millions milliard milliards deuxième troisième quatrième cinquième sixième septième
huitième neuvième dixième second seconde demi demie double triple dizaine douzaine vingtaine
centaine millier janvier février mars avril mai juin juillet août septembre octobre novembre
décembre lundi mardi mercredi jeudi vendredi samedi dimanche printemps automne hiver
weekend matinée journée soirée nuitée midi minuit aube aurore crépuscule france paris français
française françaises europe européen européenne allemagne allemand allemande angleterre anglais
anglaise espagne espagnol italie italien italienne amérique américain américaine afrique africain
asie chine chinois japon japonais russie russe belgique belge suisse canada québec londres rome
berlin enfants hommes femmes jours années choses mains amis amies parents frères sœurs filles mots
nuits heures minutes semaines siècles guerres idées questions réponses problèmes exemples parties
façons formes effets lieux terres eaux rues routes chemins pieds jambes visages cœurs maisons
villes têtes noms côtés portes lettres livres pages images photos films chansons jeux équipes
chambres salles tables chaises lits fenêtres murs jardins arbres fleurs forêts champs montagnes
rivières îles pierres couleurs lumières sentiments souvenirs rêves secrets projets actions gestes
mouvements voyages élèves professeurs écoles classes services bureaux groupes sociétés lois droits
pouvoirs états partis peuples nations membres moyens points raisons causes conditions résultats
mesures travaux prends prend prenons prenez prennent prenais prenait prenions preniez prenaient
prendrai prendras prendra prendrons prendrez prendront prendrais prendrait prendrions prendriez
prendraient prenne prennes pris prise prises prit prirent prendre prenant mets met mettons mettez
mettent mettais mettait mettaient mettrai mettra mettrons mettrez mettront mettrais mettrait mette
mis mise mises mit mirent mettre mettant crois croit croyons croyez croient croyais croyait
croyaient croirai croira croirais croirait croie cru crue crut croire croyant parle parles parlons
parlez parlent parlais parlait parlions parliez parlaient parlerai parlera parlerons parlerez
parleront parlerais parlerait parlé parlée parla parler parlant passe passes passons passez
passent passais passait passaient passerai passera passerait passé passée passés passées passa
passèrent passer passant trouve trouves trouvons trouvez trouvent trouvais trouvait trouvaient
trouverai trouvera trouverait trouvé trouvée trouvés trouvées trouva trouver trouvant donne donnes
donnons donnez donnent donnais donnait donnaient donnerai donnera donnerait donné donnée donnés
données donna donner donnant comprends comprend comprenons comprenez comprennent comprenais
comprenait comprendrai comprendra comprendrait compris comprise comprit comprendre comprenant
connais connaît connait connaissons connaissez connaissent connaissais connaissait connaissaient
connaîtrai connaîtra connue connus connaître connaitre connaissant pars partons partez partent
partais partait partaient partirai partira partirait partit partir partant demande demandes
demandons demandez demandent demandais demandait demandaient demanderai demandera demanderait
demandé demandée demanda demander demandant tiens tient tenons tenez tiennent tenais tenait
tenaient tiendrai tiendra tiendrait tenu tenue tint tenir tenant aime aimes aimons aimez aiment
aimais aimait aimaient aimerai aimera aimerais aimerait aimé aimée aimés aima aimer aimant pense
penses pensons pensez pensent pensais pensait pensaient penserai pensera penserait pensé pensa
penser pensant reste restes restons restez restent restais restait restaient resterai restera
resterait resté restée resta rester restant attends attend attendons attendez attendent attendais
attendait attendaient attendrai attendra attendrait attendu attendue attendit attendre attendant
sors sort sortons sortez sortent sortais sortait sortaient sortirai sortira sortirait sorti sortit
sortir sortant entends entend entendons entendez entendent entendais entendait entendaient
entendrai entendra entendrait entendu entendue entendit entendre entendant cherche cherches
cherchons cherchez cherchent cherchais cherchait cherchaient chercherai cherchera chercherait
cherché cherchée chercha chercher cherchant sent sentons sentez sentent sentais sentait sentaient
sentirai sentira sentirait senti sentie sentit sentir sentant vis vivons vivez vivent vivais
vivait vivaient vivrai vivra vivrait vécu vécue vécut vivre rends rend rendons rendez rendent
rendais rendait rendaient rendrai rendra rendrait rendu rendue rendit rendre rendant arrive
arrives arrivons arrivez arrivent arrivais arrivait arrivaient arriverai arrivera arriverait
arrivé arrivés arrivées arriva arriver arrivant entres entrons entrez entrent entrais entrait
entraient entrerai entrera entrerait entré entra entrer entrant portons portez portent portais
portait portaient porterai portera porterait porté portée porta porter portant laisse laisses
laissons laissez laissent laissais laissait laissaient laisserai laissera laisserait laissé
laissée laissa laisser laissant regarde regardes regardons regardez regardent regardais regardait
regardaient regarderai regardera regarderait regardé regardée regarda regarder regardant appelle
appelles appelons appelez appellent appelais appelait appelaient appellerai appellera appellerait
appelé appelée appela appeler appelant reviens revient revenons revenez reviennent revenais
revenait revenaient reviendrai reviendra reviendrait revenu revenue revint revenir revenant écris
écrit écrivons écrivez écrivent écrivais écrivait écrivaient écrirai écrira écrirait écrite écrits
écrivit écrire écrivant lis lisons lisez lisent lisais lisait lisaient lirai lira lirait lu lue
lut lire lisant perds perd perdons perdez perdent perdais perdait perdaient perdrai perdra
perdrait perdu perdue perdit perdre perdant suit suivons suivez suivent suivais suivait suivaient
suivrai suivra suivrait suivi suivie suivit suivre suivant suivante ouvre ouvres ouvrons ouvrez
ouvrent ouvrais ouvrait ouvraient ouvrirai ouvrira ouvrirait ouvert ouverte ouvrit ouvrir ouvrant
meurs meurt mourons mourez meurent mourais mourait mouraient mourrai mourra mourrait morts mortes
mourut mourir mourant tombe tombes tombons tombez tombent tombais tombait tombaient tomberai
tombera tomberait tombé tombée tomba tomber tombant sers sert servons servez servent servais
servait servaient servirai servira servirait servi servie servit servir servant joue joues jouons
jouez jouent jouais jouait jouaient jouerai jouera jouerait joué jouée joua jouer jouant montre
montres montrons montrez montrent montrais montrait montraient montrerai montrera montrerait
montré montrée montra montrer montrant commence commences commençons commencez commencent
commençais commençait commençaient commencerai commencera commencerait commencé commencée commença
commencer commençant finis finit finissons finissez finissent finissais finissait finissaient
finirai finira finirait fini finie finir finissant paye paie payes paies payons payez payent
paient payais payait payaient payerai paierai payera paiera payé payée paya payer payant oublie
oublies oublions oubliez oublient oubliais oubliait oubliaient oublierai oubliera oublierait
oublié oubliée oublia oublier oubliant réponds répond répondons répondez répondent répondais
répondait répondaient répondrai répondra répondrait répondu répondit répondre répondant travaille
travailles travaillons travaillez travaillent travaillais travaillait travaillaient travaillerai
travaillera travaillerait travaillé travailla travailler travaillant essaie essaye essaies
essayons essayez essaient essayais essayait essaierai essaiera essaierait essayé essaya essayer
essayant permet permets permettons permettez permettent permettait permettra permettrait permis
permise permit permettre permettant reçois reçoit recevons recevez reçoivent recevais recevait
recevaient recevrai recevra recevrait reçu reçue reçut recevoir recevant deviens devient devenons
devenez deviennent devenais devenait devenaient deviendrai deviendra deviendrait devenu devenue
devint devenir devenant semble sembles semblons semblez semblent semblais semblait semblaient
semblera semblerait semblé sembla sembler semblant ressemble ressemblent ressemblait ressembler
existe existent existait existera existerait existé exister change changes changeons changez
changent changeait changera changerait changé changée changea changer changeant agit agissent
agissait agira agirait agi agir agissant compte comptes comptons comptez comptent comptait
comptera compté compter comptant marche marches marchons marchez marchent marchait marchera marché
marcher marchant pose poses posons posez posent posait posera posé posée poser posant tourne
tournes tournons tournez tournent tournait tournera tourné tournée tourna tourner tournant garde
gardes gardons gardez gardent gardait gardera gardé gardée garda garder gardant apprends apprend
apprenons apprenez apprennent apprenait apprendra appris apprise apprit apprendre apprenant
reconnais reconnaît reconnait reconnaissons reconnaissez reconnaissent reconnaissait reconnu
reconnue reconnut reconnaître reconnaitre présente présentes présentons présentez présentent
présentait présentera présenté présentée présenta présenter présentant lève lèves levons levez
lèvent levait lèvera levé levée leva lever levant rentre rentres rentrons rentrez rentrent
rentrait rentrera rentré rentrée rentra rentrer rentrant court cours courons courez courent
courait courra couru courut courir courant ajoute ajoutes ajoutons ajoutez ajoutent ajoutait
agent paillasson phare colis moulin grange cachette trahison espion otage piège enveloppe
documents papiers volet volets abri autobus bagage balcon bible boulanger caillou casque cirque
ciseaux colle collier craie crochet fée ficelle foulard gilet grain grille hibou marteau patte
pelle pinceau pistolet planète poêle pompier poubelle puits rangée roche sapin seau serviette
tablier tambour timbre torchon tortue tracteur tuyau veau voleur jetée entrepôt cabanon planque
cachot crypte fuyez prévenez cachez brûlez détruisez sauvez fuis cachées dépêchez
ajoutera ajouté ajoutée ajouta ajouter ajoutant reprend reprends reprenons reprenez reprennent
reprenait reprendra repris reprise reprit reprendre retrouve retrouves retrouvons retrouvez
retrouvent retrouvait retrouvera retrouvé retrouvée retrouva retrouver explique expliques
expliquons expliquez expliquent expliquait expliquera expliqué expliquée expliqua expliquer
continue continues continuons continuez continuent continuait continuera continué continua
continuer écoute écoutes écoutons écoutez écoutent écoutait écoutera écouté écouta écouter
écoutant ferme fermes fermons fermez ferment fermait fermera fermé fermée ferma fermer monte
montes montons montez montent montait montera monté montée monta monter montant descends descend
descendons descendez descendent descendait descendra descendu descendue descendit descendre aide
aides aidons aidez aident aidait aidera aidé aidée aida aider espère espères espérons espérez
espèrent espérait espérer espéré envoie envoies envoyons envoyez envoient envoyait enverra
enverrait envoyé envoyée envoya envoyer achète achètes achetons achetez achètent achetait achètera
acheté achetée acheta acheter vend vends vendons vendez vendent vendait vendra vendu vendue vendit
vendre offert souffert découvert couvert offre offres offrons offrez offrent offrait offrira
offrit offrir découvre découvres découvrons découvrez découvrent découvrait découvrira découvrit
découvrir couvre couvrent couvrait couvrir souffre souffres souffrons souffrez souffrent souffrait
souffrir dors dort dormons dormez dorment dormait dormira dormi dormir boit buvons buvez boivent
buvait boira bu boire mange manges mangeons mangez mangent mangeait mangera mangé manger conduis
conduit conduisons conduisez conduisent conduisait conduira conduite conduire produit produisent
produisait produira produire construit construisent construisait construire détruit détruisent
détruire traduit traduire réduit réduire introduit introduire choisis choisit choisissons
choisissez choisissent choisissait choisira choisi choisie choisir réussis réussit réussissons
réussissez réussissent réussissait réussira réussi réussir remplit remplir rempli grandit grandir
grandi réfléchis réfléchit réfléchir réfléchi obéir obéit bâtir bâti nourrir nourrit punir puni
jeter jette jettent jetait jeté peser pèse mener mène mènent menait mené amener amène amené
emmener emmène emmené promener promène promené promenade craindre crains craint craignait crainte
plaindre plains plaint joindre joint jointe peindre peint peinte atteindre atteint atteinte
éteindre éteint éteinte rejoindre rejoint battre bat battent battait battu combattre combat
combattu naître naît naquit né née nés nées naissance paraître paraît parait paraissait paru
apparaître apparaît apparu disparaître disparaît disparu disparue plaire plaît plait plu taire
tait tue rire rit riait ri rires sourire sourit souriait souri valoir vaut valait vaudra vaudrait
valu falloir faut fallait faudra faudrait fallu faille pleuvoir pleut pleuvait asseoir assis
assise assied asseyait convaincre convaincu vaincre vaincu résoudre résout résolu cueillir cueille
accueillir accueille accueilli fuir fuit fuyait fui mentir ment menti poème poèmes poésie poète
rime rimes strophe strophes plume encre ligne lignes phrase phrases titre texte textes auteur
auteurs écrivain lecteur lectrice lecture écriture roman romans conte contes récit récits chapitre
langue langues langage parole paroles discours honneur faveur ardeur flamme flammes amours passion
baiser baisers caresse tendresse âmes larme larmes soupir soupirs regards beauté charme grâce
douceur bonheur malheur peine chagrin désespoir étoiles destin fortune gloire éternité éternel
éternelle instant hommage délire remède maux créateur adorer adore adorais chéris chérir chéri
chérie couche couché couchée coucher couchait réclame réclamer réclamait ose oser osais osé
apporter capturé capturer forma former soin justice liberté égalité fraternité violence crime
prison police juge avocat procès tribunal victime témoin preuve enquête indice clef serrure coffre
trésor carte code chiffre signal signe symbole énigme devinette solution piste trace drapeau caché
cachée cachés cacher cache deviner décoder coder chiffrer déchiffrer ordinateur internet site
réseau logiciel programme fichier système écran clavier souris téléphone portable application
technologie numérique informatique machine appareil robot science scientifique recherche chercheur
laboratoire expérience théorie analyse résultat calcul nombre mesure pain beurre fromage lait
crème œuf œufs viande bœuf porc poulet poisson riz pâtes soupe salade fruit fruits pomme orange
banane raisin citron fraise cerise pêche poire tomate oignon ail carotte haricot légume légumes
sel poivre sucre miel huile vinaigre sauce gâteau biscuit tarte chocolat bonbon thé café jus vin
bière boisson déjeuner dîner souper repas assiette bol tasse verre fourchette couteau cuillère
bouteille cuisine boulangerie boucherie épicerie magasin boutique supermarché restaurant chien
chat cheval vache cochon mouton chèvre poule canard oiseau oiseaux rat lapin ours loup renard lion
tigre éléphant singe serpent grenouille insecte abeille mouche fourmi araignée papillon baleine
requin dauphin cerf animal animaux bête bêtes chemise pantalon jean robe jupe manteau veste pull
costume cravate chapeau casquette chaussure chaussures botte chaussette gant écharpe ceinture sac
poche bouton bague vêtement vêtements habit habits médecin infirmière infirmier enseignant
étudiant étudiante policier soldat pilote chauffeur conducteur paysan agriculteur ouvrier ouvrière
ingénieur artiste chanteur chanteuse acteur actrice danseur danseuse joueur joueuse entraîneur
directeur directrice chef capitaine marin prêtre curé patron patronne employé employée client
cliente vendeur vendeuse voisin voisine compagnon compagne camarade copain copine cousin cousine
oncle tante neveu nièce bébé garçon garçons dame dames monsieur messieurs madame mesdames
mademoiselle sieur voiture voitures train trains avion bateau bateaux vélo moto bus métro camion
taxi gare aéroport port station arrêt billet ticket vacances hôtel valise passeport frontière
douane santé maladie hôpital médicament docteur soins blessure blessé fièvre ventre estomac poumon
dent dents gorge doigt doigts ongle genou os muscle cerveau euro euros franc francs prix coût
valeur banque crédit dette paiement salaire impôt impôts taxe commerce économie entreprise affaire
affaires vente achat industrie usine emploi chômage métier carrière église dieux paradis enfer
ange anges diable saint sainte saints prière croix foi religion messe village quartier région
province département commune capitale campagne banlieue centre avenue boulevard pont autoroute
parc musée château palais tour monument bâtiment immeuble appartement étage escalier ascenseur
cave grenier cour couloir salon toilettes douche bain baignoire lavabo évier four frigo
réfrigérateur lampe miroir tapis rideau canapé fauteuil armoire placard étagère tiroir collège
lycée université leçon devoirs examen note notes diplôme étude études maîtresse instituteur cahier
stylo crayon gomme règle bibliothèque tableau achats allumer annoncer apercevoir appuyer arrêter
attacher attraper augmenter avancer baisser balayer bouger briller brûler casser causer céder
chanter charger chasser chauffer coller commander comparer conclure confier conserver considérer
consulter contenir convenir corriger couper coûter créer creuser crier critiquer cuire danser
décider déclarer décrire défendre demeurer dépasser dépendre déposer désirer dessiner détester
développer diminuer diriger discuter disposer distinguer divorcer doubler douter dresser durer
échapper éclairer échouer économiser élever éloigner embrasser empêcher employer emporter enlever
ennuyer enseigner entourer entraîner épouser éprouver essuyer établir étendre étonner étudier
éviter examiner exiger exprimer fabriquer fâcher fixer frapper gagner glisser goûter habiter
hésiter ignorer imaginer imposer indiquer inquiéter installer intéresser interdire inventer
inviter juger jurer laver libérer lier livrer louer manquer marier marquer mériter mesurer mêler
mélanger menacer mentionner modifier nager noter obliger observer obtenir occuper organiser
pardonner partager participer pencher percevoir placer pleurer plier posséder pousser pratiquer
préférer préparer prêter prétendre prévenir prévoir prier profiter promettre proposer protéger
prouver quitter raconter ramasser ranger rappeler rapporter rater recommencer recueillir refuser
regretter rejeter relever remarquer remercier remettre remonter remplacer rencontrer renoncer
renverser répandre réparer repartir répéter replacer reposer représenter réserver résister
respecter respirer ressentir retenir retirer retourner réunir réveiller révéler rêver risquer
rouler saisir saluer satisfaire sauter sauver sécher secouer séparer serrer signer signifier
soigner sonner souffler souhaiter soulever soumettre soupçonner supporter supposer surprendre
surveiller tâcher téléphoner terminer tirer toucher traîner traiter transformer traverser tromper
tuer unir utiliser verser visiter voler voter présent futur avenir époque période ère âge jeunesse
enfance vieillesse décès mariage noces fête anniversaire cadeau surprise sujet thème objet aspect
élément facteur rôle fonction position situation condition niveau rang degré taux quantité qualité
importance intérêt avantage inconvénient risque danger chance occasion possibilité moyen méthode
technique structure organisation modèle type espèce catégorie série total somme débat discussion
conversation dialogue réunion rencontre conférence entretien accord désaccord conflit crise lutte
bataille victoire défaite armée soldats arme armes nature environnement climat température saison
météo orage tempête nuage nuages brouillard glace gel sécheresse inondation tremblement grandeur
hauteur largeur longueur profondeur poids taille vitesse distance espace surface volume mètre
kilomètre centimètre litre kilo gramme coup vision reflet tort faim soif sommeil honte marchaient
montaient couraient dormaient soudain aussitôt tantôt désormais dorénavant autrefois jadis naguère
auparavant récemment prochainement dernièrement actuellement ci oh ah eh hé hein bah bof hélas zut
chut ouf aïe bravo excusez excuse drapeaux clés chiffres codes messages indices énigmes trésors
cartes accepter admirable accepté accorder cabane race admettre abandon aimable accompagné admirer
fable paille amer affirmer accordé amère écart accroché idéal racine abandonner habiller paire
grosses cadre ardent amuser sacré jaloux admis face échange ardente appartenir baigner adoré abord
lâcher aveugle apprécier affirmé bavard cage fortement maigre approcher dangereux radio agité
tache arracher pâle arranger caisse absence gai blond échec panier blonde assister légèrement
assurer matins danse laid vague allumé bouleversant attaquer panne absolu tâche échelle brave
attirer habitant caresses bref uniforme amusé avaler profondément brève annoncé date éclair papa
maire avertir chapeaux camp brillant avouer rois aperçu laine gaieté balancer davantage brillante
barrer quai éclat mairie brutal accès sérieusement paquet bavarder débarrasser canal blesser
apporté bondir balle capable tailleur border boucher reines accident bouillir approché vaisselle
briser faiblesse gravement candidat bronzer debout endroits brosser appuyé parapluie canon gamin
calculer arraché rapport accompagner charmant calmer bande caresser arrangé tendrement majorité
princes célébrer chauve arrêté rare talent chétif caractère assuré tristement chuchoter chic citer
banc raser attaché nappe obscur clouer carré fantôme coiffer attaqué paresse commun lame rasoir
complet joyeusement parfait habitude attiré éditeur accueil carton décision complète concevoir
attrapé barbe farine illusion compliqué rassurer augmenté conquérir éducation confus parfum
consentir accuser avancé catastrophe soirs consoler découverte constater vallée avoué correct
effacer contempler places fatigue baissé coupable contenter barque acier conter taper contraindre
brusquement courageux rayon copier effort courageuse bougé coudre couler brisé actuel lancer
courber haine fatigué réalité courte brûlé égal soudainement maman barrière sauvage cruel union
cracher craquer cruelle crever actuelle calmé récent chevaux croiser manche cercle croquer cassé
subitement faute vapeur causé cultiver cérémonie défaut délicat savant débarquer débrouiller
délicieux ombres manteaux plats certes chanté décorer vivement découper chiens élan chargé adresse
désert manier décrocher chassé désolé dédier hasard sourires veille défaire savon électricité
dégager violemment déguiser adresser chaîne digne coupé parvenir tas défense démarrer scène direct
déménager chats chair électrique démolir discret dénoncer adulte dépenser fièrement discrète
veiller crié passage déplacer déplaire élégant distrait dégoût cueilli déranger passager divin
favorable séance désigner cuit mauvaises doré librement dansé détacher marbre soirées détourner
hausse décidé affreux déclaré durable dévorer champion marchand dicter record clairement éclatant
navire décrit poissons patience effrayant teint marchandise défendu secours gauche disputer bâton
patient latin distribuer diviser chant dominer élevé agréable reculer délai émouvant déposé
paupière dérangé sécurité précisément ébranler hâte cris aile écarter fer échanger épais dessiné
émission seigneur éclater épaisse gaz unique zone écraser épatant paysage charbon rarement deviné
effrayer sein essentiel émotion égarer charge éliminer embarquer télévision étranger séjour empire
évident émouvoir douté exact régime emprunter excellent dressé pécher gazon encourager chasse
chants endormir généralement enfermer exceptionnel échappé robes enfoncer peigne oeil enfuir
extraordinaire éclairé engager demeure fâché éclaté féroce enregistrer semblable habituellement
bec enterrer fameux journées écrasé marque entreprendre familier peintre effacé envahir regret
géant envelopper peinture normalement épargner favori éplucher alcool éloigné fertile pelouse
épuiser embrassé ému fidèle oeuvre sensible masse estimer spécialement empêché étaler sentier fine
démocratie étouffer pendre fixe geler emporté cheminée évaluer particulièrement éveiller flou
enfermé pénible matériel feuille temple évoquer chêne fondamental exagérer enlevé lendemain
exciter formidable endroit exécuter ennuyé exercer matière personnellement pente insectes enseigné
nerveux expédier fragile tendre entouré énergie exploiter frais ponts explorer exposer entraîné
gendarme fraîche politiquement cheveu faillir unité épousé bijou franche fatiguer feindre
féliciter impression dépense fréquent fendre socialement fêter mécanique feuilleter amitié
personnage établi furieux figurer choc filer tentative filmer nettoyer génération gaie choix
étendu flatter économiquement héros promesses flotter perte fonder étonné fondre forcer génial
étudié tenter fouiller volontiers fournir chute évité amoureux franchir figure ennemi humainement
blague glacé freiner vagues meilleur cible frémir glorieux frotter exprimé parfums souliers
gâteaux gourmand fumer ennui terme amoureuse génie garantir seuil gracieux remuer mélange garer
fil cigarette grave gaspiller lèvre pharmacie gâter fixé ampoule gémir cinéma rochers membre gêner
serments formé habile gonfler franchement circonstance frappé habituel indépendance gouverner
sévère filet hardi gagné amusant gratter circulation grelotter griffer blé pièce grimper désordre
enseignement terrain grogner honnête cité sincèrement grossir glissé guérir exprès guetter goûté
guider citoyen siège humble haïr dessin humide hausser civil guéri honnêtement piéton heurter sien
honorer habillé hurler ignorant identifier prières ménage habité imiter pipe importer hésité âne
poliment immobile terreur imprimer ignoré impatient piquer inscrire insister imaginé inspirer lien
univers collines inquiet instruire destruction gentiment incroyable inquiété pitié interroger
interrompre enthousiasme saisons installé joli cloche individu bloc intelligent interdit jaillir
détail calmement firme clou intense plafond inventé vallées vœux jouir intéressant invité angle
menton club intime inutile tranquillement lécher mépris invisible jugé plaine ivre lancé nid
opération loger coeur lutter silencieusement lavé mâcher anneau maigrir boîte plaisanterie
maintenir joyeux maîtriser libéré manifester juste coin annonce deuil lié basses plaines désirs
odeurs gants bonbons quasi secrètement colère massacrer manqué maudire méditer las marié soeur
méfier planche colline marqué discrètement ménager plancher colonne mendier noble opinion menacé
soie limite mépriser repos plante lisse merveille mérité meubler plat lourdement local miauler
plateau moquer comédie merveilleux mordu mordre moucher tissu plaisirs prés mouiller vieillard
loyal commande longuement multiplier blanches munir nommé lumineux murmurer commencement noté
magique épaule négliger noce neiger nourri nier diamant noircir obligé foire pli appel nommer épée
commission liquide majeur observé nouer toits plomb métal noyer obtenu nuire toile épicier
pleinement occupé plonger différence sol communauté malin douleurs maladroit villages inquiétude
compagnie omettre organisé épingle vif opérer marron appétit opposer bosse ordonner réserve
difficulté noeud orner noires ôter folie applaudir jouet pâlir pardonné solide épouse parcourir
vigne partagé mince bottes parer parier mineur solitude épreuve misérable comportement poignée
penché peines patienter respect meuble composer patiner modeste pendu équilibre poing liste
ordinaire peigner mol molle pénétrer tonnerre mou rouges sons bijoux verres percer placé pointe
comte planté périr muet erreur persuader appui pleuré concert mûr direction photographier sommet
poitrine picorer plié mystérieux plongé naïf poli joies plaisanter concours naïve goutte planter
militaire fontaine dirigeant boue possédé natal condamner songer poussé polir net préféré
poursuivre nette instinct préparé confiance foules vertes mine pompe précéder usage prédire neuve
espérance confondre prêté prélever prévenu confort nombreux population préserver retard prévu
presser craintes normal congé prié bougie uniquement nu conscience essai nue priver violent
procéder profité instrument conseil progresser portrait promis odieux sot projeter essence
conseiller proposé original boule prononcer voisins protégé sou conséquence protester bleues
paisible prouvé provoquer queue principalement publier quitté misère souci raccrocher disque
raconté doutes bouquet rafraîchir passionnant ralentir ramassé intelligence tousser mission
construction ramener essentiellement poste ramené graine logique visite rangé contact pot souffle
rassembler mode arrière rappelé époques permanent étape rattraper bourse rapporté ravir ennemis
réagir réaliser rassuré poupée pieux réchauffer rechercher raté orgueil réciter poussière
souffrance grises bruits bagues tasses récolter recommander horizon espoirs contenu poutre réclamé
pointu réconcilier divers fosse recopier contraire pratique recouvrir récupérer populaire
redescendre pareillement redevenir contrat précieux positif tradition redire refusé redouter
réveil refaire regretté contrôle précis regagner régler relevé gras intention nord origine zéro
soulier remarqué réjouir loisir pressé remercié foule relier horloge relire différemment douces
remis principal rembourser cousins châteaux copie remonté domaine remplacé corde vitre présence
renfermer source rencontré trait renseigner dommage associer prudent renversé renvoyer
difficilement sourd réparé revoir monnaie pur répété repasser don replier reposé horreur moments
révolution repousser bébés coton réel fortes atelier reprocher fraîcheur régulier presse cou
respecté remarquable événement retenu lors reconnaissant attaque retiré rond richesse évidence
coude retomber retourné transport églises promptement royal réuni sitôt hôte pensées rude dossier
rusé attention réveillé maîtres spectacle rompre ronfler révélé rougir faibles colliers assiettes
ruiner revu saigner principe sain nourriture salir risqué sangloter roulé moral sanglant grippe
sauté attitude satisfait sculpter courage sauvé utile statue brique morceau séduire trembler séché
séjourner intérieur semer secoué style courrier guère médecins siffler séparé signaler tremper
succès brosse ouest serré course exception riches rocher loyer vol silencieux instants signé
audace ouvriers moteur soulager soigné souligner sincère sud profit sonné soupirer doute exercice
soufflé passions soutenir premièrement suffire subir souhaité succéder gronder sucer paysans
soulevé mouchoir souple suggérer front coutume suite outil supplier deuxièmement surpris
souterrain supprimer existence progrès surgir surveillé surmonter spécial autorité volonté
couverture pauvres sursauter taillé splendide marchands survivre stupide suspendre tendu tacher
tailler subtil terminé sublime humeur tarder mousse supérieur tiré explication teindre drame
suffisant création témoigner touché promesse avance voleurs ouvrage trou tisser tolérer creux roue
drap propos traîné tondre surprenant exploser fuite quotidien tordre traité sympathique lunettes
voyager troupe transformé juges tracer critique heureuses silences rubans bouteilles trahir
traversé anciennement crocodile tremblé timide propriétaire fumée feux transmettre transporter
trompé exposition troupeau aventure droite avocats tricher tué tricoter expression trier urgent
guide triompher uni troubler utilisé ruban présentement cuir user parcs vaillant luxe avis témoins
bulle vaste extérieur fusil versé pis venger cuisinier tristes puissance vidé humour cendres
vilain numéro vêtir vider culture ruine puissant visité guitare vieillir volé visible prisonniers
durée vomir ruisseau extrême curiosité voyagé`;
