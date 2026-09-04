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

Le fichier `usagectl-presence.json` ne contient aucun nom de compte : uniquement des horodatages et des nombres de sessions.

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
- `usagectl-cache.json` : agrégats hebdomadaires recalculables.

Conservez `usagectl-presence.json` dans vos sauvegardes : contrairement au cache, il ne peut pas être reconstruit à partir de la power timeline.
