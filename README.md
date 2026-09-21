# usagectl pour MeshCentral

Plugin d'administration MeshCentral qui mesure l'occupation réelle des postes par salle.

## Définition du taux

Un poste est considéré comme **occupé** dès qu'au moins une session utilisateur OS est ouverte. Il redevient libre quand la dernière session se ferme/se déconnecte, ou dès que le PC s'éteint et que l'agent MeshCentral se déconnecte. Pour une salle :

```text
taux d'occupation = temps cumulé des postes occupés / temps cumulé des postes observés
```

Exemple : dans une salle de 20 postes observée pendant 10 heures, 50 heures-poste occupées donnent un taux de 25 % (`50 / (20 × 10)`). Plusieurs sessions simultanées sur le même poste ne font pas dépasser sa contribution au-delà de 100 %.

Le plugin affiche séparément :

- l'**occupation**, issue de `coreinfo.users` (sessions OS ouvertes) ;
- l'**allumage**, issu de la power timeline MeshCentral ;
- l'allumage hors horaires, qui reste un indicateur de gaspillage énergétique.

Dans la vue Salles, les durées sont réparties en trois colonnes :

- **Temps utilisé** : durée moyenne avec une session utilisateur ouverte ;
- **Temps allumé** : durée moyenne pendant laquelle le poste était sous tension ;
- **Temps semaine** : période déjà mesurée dans la semaine sélectionnée, jusqu'à 50 heures pour une semaine complète (lundi-vendredi, 8 h-18 h).

Le fichier `usagectl-presence.json` ne contient aucun nom de compte : uniquement des horodatages et des nombres de sessions.

## Temps d'ouverture de session Windows

L'onglet **Temps de connexion** mesure, pour chaque poste Windows, le délai entre la dernière saisie Windows précédant la création de la session et la disponibilité confirmée du bureau pour ce même utilisateur. Cette saisie correspond normalement à l'appui sur Entrée après le login et le mot de passe. Elle est lue directement par MeshAgent dans `WTSINFO.LastInputTime`, sans lancer de commande externe. Si elle est absente, incohérente ou postérieure à la création de session, le plugin utilise automatiquement `WTSINFO.LogonTime`, puis l'événement 4624 ou `Win32_LogonSession` sur les anciens agents. Le système ne peut toutefois pas garantir que la dernière saisie était physiquement la touche Entrée ; cette source est donc affichée explicitement dans l'historique.

Le démarrage d'`explorer.exe` ne suffit pas à lui seul : Windows peut lancer ce processus alors que l'écran « Connexion » ou « Bienvenue » est encore visible. Le plugin attend donc aussi la disparition de `LogonUI.exe` et de `userinit.exe`, puis confirme cet état sur deux contrôles successifs espacés d'environ cinq secondes. La fin enregistrée est l'instant de cette confirmation, avec une précision correspondant à cet intervalle de surveillance.

L'onglet affiche aussi le **temps moyen global du lycée** et le **temps moyen de chaque salle**, accompagnés du nombre de connexions réussies et de postes mesurés. Chaque connexion réussie de la période sélectionnée compte une fois dans ces moyennes. La même synthèse est ajoutée aux rapports PDF.

Il n'existe aucune limite de durée : une connexion de 10, 20 minutes ou davantage reste affichée comme « en cours ». Si la session se ferme ou si le poste se déconnecte avant la disponibilité confirmée du bureau, la tentative est conservée comme mesure incomplète avec sa durée. Les mesures en cours sont enregistrées sur disque afin de survivre à un rechargement du plugin.

Selon la version de MeshAgent, le détail du processus peut ne pas contenir son heure de démarrage. Lorsque le processus Explorer appartient bien au même utilisateur ou à la même session Windows, le plugin utilise alors son instant de détection, avec une précision maximale de 5 secondes. L'interface affiche aussi l'étape de détection en cours pour faciliter le diagnostic.

Si le poste ne fournit ni événement 4624 ni session interactive exploitable, le plugin conserve une **mesure incomplète** plutôt que d'enregistrer une durée artificielle de quelques secondes. Cela ne signifie pas que la connexion Windows a échoué : l'historique indique séparément si le bureau a bien été détecté.

La version 0.0.41 réinitialise les anciennes mesures de temps de connexion, car elles utilisaient la notification tardive `coreinfo.users` comme point de départ et pouvaient donc afficher à tort seulement 0 à 9 secondes.

Les rapports PDF incluent une section dédiée au temps d'ouverture de session, avec les mêmes mesures que l'onglet, aussi bien pour une semaine précise que pour une période glissante.

Chaque poste dispose d'un bouton **Historique** qui affiche toutes les tentatives de la période sélectionnée : début Windows, apparition du bureau ou fin, durée, compte Windows, résultat, source de mesure et raison d'un éventuel échec. Le même historique détaillé est ajouté aux rapports PDF. Les mesures créées avant la version 0.0.48 affichent « — » pour l'utilisateur, car cette information n'était pas encore enregistrée.

## Important après la mise à jour

MeshCentral expose l'état courant des sessions, mais ne conserve pas leur historique. La mesure de présence commence donc au premier démarrage de cette version du plugin. Les semaines antérieures restent disponibles pour les données électriques, mais pas pour l'occupation humaine.

La rétention de présence est de 400 jours. Les calculs hebdomadaires sont limités à lundi-vendredi, 8 h-18 h, selon le fuseau horaire du serveur.

## Installation

Dans l'administration MeshCentral, installez le plugin avec l'URL de son fichier de configuration :

```text
https://raw.githubusercontent.com/V3locidad/usagectl-meshcentral/main/config.json
```

Après installation ou mise à jour, redémarrez MeshCentral ou rechargez le plugin. Vérifiez ensuite l'état du collecteur avec :

```text
/pluginadmin.ashx?pin=usagectl&action=presenceStatus
```

La réponse indique la date de début, le nombre de postes suivis et la durée de rétention.

## Données locales

- `usagectl-presence.json` : historique compact des changements de présence ;
- `usagectl-logins.json` : durées d'ouverture de session et nom du compte Windows associé ;
- `usagectl-cache.json` : agrégats hebdomadaires recalculables.

Conservez `usagectl-presence.json` et `usagectl-logins.json` dans vos sauvegardes : contrairement au cache, ils ne peuvent pas être reconstruits à partir de la power timeline.
