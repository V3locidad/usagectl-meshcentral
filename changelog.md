# Changelog

## 0.0.49

- L’historique brut d’occupation et de connexion reste conservé 400 jours, et le cache couvre désormais 60 semaines afin de consulter une année complète.
- Ajout du mode « Dates précises » pour sélectionner librement un début et une fin, avec ou sans limitation aux horaires Lun-Ven 8h-18h.
- Le sélecteur de semaines affiche maintenant les 53 dernières semaines.
- Depuis le détail d’une salle, le bouton « Rapport PDF » génère uniquement le rapport de cette salle, y compris ses postes et ses temps de connexion.

## 0.0.48

- Ajout du nom du compte Windows dans l'historique des temps de connexion de chaque poste.
- Le même utilisateur est affiché dans l'historique détaillé des rapports PDF.
- Les nouvelles mesures conservent le compte dans `usagectl-logins.json` ; les anciennes affichent « — » sans perdre leur historique.

## 0.0.47

- Ajout du temps moyen global de connexion pour l'ensemble du lycée dans l'onglet « Temps de connexion ».
- Ajout du temps moyen par salle, avec le nombre de connexions réussies et le nombre de postes effectivement mesurés.
- Les moyennes sont pondérées par connexion réussie : chaque connexion de la période sélectionnée compte une fois.
- La synthèse globale et par salle est également incluse dans les rapports PDF.

## 0.0.46

- Le départ du chronomètre utilise maintenant la dernière saisie Windows précédant la création de session, ce qui correspond normalement à l'appui sur Entrée après le login et le mot de passe.
- Cette heure récupère la phase de validation des identifiants qui manquait auparavant entre le chrono manuel et `WTS LogonTime`.
- Si Windows ne fournit pas une saisie fiable antérieure au logon, le plugin conserve automatiquement l'heure de création de session comme secours.
- La source affichée dans l'historique et le PDF distingue « Validation clavier Windows » de « Session Windows ».

## 0.0.45

- Le démarrage précoce d'`explorer.exe` ne clôt plus immédiatement la mesure pendant que Windows affiche encore « Connexion » ou « Bienvenue ».
- Le bureau n'est considéré disponible qu'après la disparition de `LogonUI.exe` et `userinit.exe`, puis deux contrôles successifs sans écran de connexion.
- La fin enregistrée correspond maintenant à la disponibilité confirmée du bureau, et non à l'heure de création souvent prématurée du processus Explorer.
- L'état en cours distingue l'initialisation Windows de la confirmation finale du bureau.

## 0.0.44

- L'heure de connexion est maintenant lue directement dans la session Windows par MeshAgent via WTS, sans lancer PowerShell ni parcourir le journal Security.
- Cette lecture native reste disponible même lorsqu'une autre commande distante occupe déjà le canal `runcommands` du poste.
- L'événement 4624 et `Win32_LogonSession` restent utilisés automatiquement en secours sur les anciens agents ne fournissant pas les informations WTS.

## 0.0.43

- Correction des mesures marquées « lecture Windows expirée » alors que la connexion avait réussi : l'événement Windows 4624 est maintenant interrogé avant CIM.
- Suppression des associations `Win32_LoggedOnUser` répétées, qui pouvaient bloquer plusieurs dizaines de secondes sur certains postes ; le secours CIM utilise directement la session interactive la plus récente.
- Le délai de réponse laissé aux postes lents passe de 15 à 30 secondes par essai.
- L'interface et le PDF parlent désormais de « mesure incomplète » et précisent qu'il ne s'agit pas d'un échec de connexion Windows lorsque le bureau a bien été détecté.

## 0.0.42

- Ajout d'un historique dépliable par poste avec le début Windows, la fin ou l'apparition du bureau, la durée, le résultat, la source de mesure et la raison d'un échec.
- Les tentatives réussies, en cours et non abouties sont désormais toutes visibles dans l'interface et dans le rapport PDF.
- Le résumé n'affiche plus « En attente d'une connexion » lorsqu'une tentative non aboutie existe.
- Renforcement de la lecture `Win32_LogonSession` en utilisant explicitement l'association `Win32_LoggedOnUser` ; les erreurs et absences de session sont distinguées dans l'historique.

## 0.0.41

- Le départ du chronomètre utilise désormais l'heure de création de la session interactive Windows (`Win32_LogonSession`), avec l'événement de sécurité 4624 en secours, au lieu de la notification tardive `coreinfo.users`.
- Le plugin peut retrouver rétrospectivement une connexion ayant réellement duré 10 ou 20 minutes même si MeshAgent ne signale l'utilisateur qu'au moment où le bureau apparaît.
- Si Windows ne fournit aucune heure de création fiable, la tentative est classée non aboutie au lieu d'enregistrer une fausse mesure de quelques secondes.
- Les anciennes mesures de 0 à 9 secondes, calculées avec le mauvais point de départ, sont réinitialisées lors de cette mise à jour.

## 0.0.40

- Ajout du temps d'ouverture de session Windows dans les rapports PDF, pour les semaines précises comme pour les périodes glissantes.
- Le rapport reprend l'état actuel, la dernière durée, la moyenne, le maximum, le nombre de mesures et les tentatives non abouties de chaque poste.
- Le rapport PDF peut désormais être généré directement depuis n'importe quel onglet en mode période glissante.

## 0.0.39

- Correction de la détection d'Explorer lorsque MeshAgent renvoie le nom de processus `explorer` sans l'extension `.exe`.
- Une réponse `psinfo` sans heure de démarrage ne laisse plus le chronomètre bloqué si l'utilisateur ou la session Windows concorde ; l'instant de détection est alors utilisé (précision maximale de 5 secondes).
- L'état en cours indique désormais si le plugin attend MeshAgent, attend Explorer ou a déjà détecté Explorer.

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
