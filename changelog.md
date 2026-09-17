# Changelog

## 0.0.38

- Ajout d'un onglet « Temps de connexion » avec dernière durée, moyenne, maximum et nombre de mesures par poste Windows.
- Le chronomètre démarre à la détection d'une nouvelle session par MeshAgent et s'arrête au démarrage d'`explorer.exe` pour le même utilisateur.
- Aucun timeout : une ouverture de session de 10, 20 minutes ou davantage reste suivie jusqu'à l'apparition du bureau.
- Les tentatives interrompues par une fermeture de session ou une déconnexion de l'agent sont conservées comme non abouties.
- Les mesures en cours survivent aux rechargements du plugin et aucun nom d'utilisateur n'est enregistré.

## 0.0.37

- Séparation des durées moyennes en trois colonnes : temps utilisé, temps allumé et temps de semaine déjà mesuré.
- Ajout des mêmes durées dans le détail des postes et les rapports PDF.
- Le taux d'allumage reste affiché dans une colonne distincte de sa durée.

## 0.0.36

- Initialisation immédiate de tous les nœuds au démarrage ou au rechargement du plugin.
- Un poste hors ligne est initialisé comme libre ; un poste en ligne reprend sa liste de sessions connue.
- Affichage de l'heure exacte de début de collecte pour éviter de confondre une minute d'observation avec une semaine complète.

## 0.0.35

- Calcul du taux d'occupation à partir des sessions OS ouvertes (`coreinfo.users`).
- Historique local compact, sans stockage des noms d'utilisateurs, avec 400 jours de rétention.
- Arrêt du comptage à la déconnexion de la dernière session utilisateur ou lors de l'extinction/déconnexion de l'agent MeshCentral.
- Séparation claire entre occupation humaine et taux d'allumage.
- Heat-map, comparatif hebdomadaire, détail et top postes basés sur la présence réelle.
- Endpoint `presenceStatus` pour contrôler le démarrage du collecteur.

## 0.0.34

- Tri des colonnes de la vue Salles.
