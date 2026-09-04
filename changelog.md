# Changelog

## 0.0.35

- Calcul du taux d'occupation à partir des sessions OS ouvertes (`coreinfo.users`).
- Historique local compact, sans stockage des noms d'utilisateurs, avec 400 jours de rétention.
- Arrêt du comptage à la déconnexion de la dernière session utilisateur ou lors de l'extinction/déconnexion de l'agent MeshCentral.
- Séparation claire entre occupation humaine et taux d'allumage.
- Heat-map, comparatif hebdomadaire, détail et top postes basés sur la présence réelle.
- Endpoint `presenceStatus` pour contrôler le démarrage du collecteur.

## 0.0.34

- Tri des colonnes de la vue Salles.
