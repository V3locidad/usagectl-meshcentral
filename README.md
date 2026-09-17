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

L'onglet **Temps de connexion** mesure, pour chaque poste Windows, le délai entre la création de la session interactive Windows et le démarrage d'`explorer.exe` pour ce même utilisateur. L'heure de départ provient de `Win32_LogonSession`, avec l'événement de sécurité 4624 en secours. Elle correspond au moment où Windows a validé les identifiants et créé la session ; l'instant physique exact où la touche Entrée est pressée n'est pas exposé par MeshAgent.

Il n'existe aucune limite de durée : une connexion de 10, 20 minutes ou davantage reste affichée comme « en cours ». Si la session se ferme ou si le poste se déconnecte avant le démarrage d'`explorer.exe`, la tentative est conservée comme non aboutie avec sa durée. Les mesures en cours sont enregistrées sur disque afin de survivre à un rechargement du plugin.

Selon la version de MeshAgent, le détail du processus peut ne pas contenir son heure de démarrage. Lorsque le processus Explorer appartient bien au même utilisateur ou à la même session Windows, le plugin utilise alors son instant de détection, avec une précision maximale de 5 secondes. L'interface affiche aussi l'étape de détection en cours pour faciliter le diagnostic.

Si le poste ne fournit ni session interactive exploitable ni événement 4624, le plugin classe la tentative comme non aboutie plutôt que d'enregistrer une durée artificielle de quelques secondes.

La version 0.0.41 réinitialise les anciennes mesures de temps de connexion, car elles utilisaient la notification tardive `coreinfo.users` comme point de départ et pouvaient donc afficher à tort seulement 0 à 9 secondes.

Les rapports PDF incluent une section dédiée au temps d'ouverture de session, avec les mêmes mesures que l'onglet, aussi bien pour une semaine précise que pour une période glissante.

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
- `usagectl-logins.json` : durées d'ouverture de session, sans nom d'utilisateur ;
- `usagectl-cache.json` : agrégats hebdomadaires recalculables.

Conservez `usagectl-presence.json` et `usagectl-logins.json` dans vos sauvegardes : contrairement au cache, ils ne peuvent pas être reconstruits à partir de la power timeline.
