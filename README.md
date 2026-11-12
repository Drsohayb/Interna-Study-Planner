# Interna Study Planner

Application locale React + TypeScript + Tailwind CSS pour organiser les cours et les révisions J0/J1/J3/J7/J15/J30.

## Lancer sur Linux
1. Installer Node.js (version LTS) et npm.
2. Décompresser le dossier.
3. Dans un terminal, entrer dans `Interna_Study_Planner`.
4. Lancer `npm install`
5. Lancer `npm run dev`
6. Ouvrir l'adresse locale affichée par Vite (généralement http://localhost:5173).

Les coches et les dates sont enregistrées automatiquement dans le localStorage du navigateur. Utilise Exporter pour faire une sauvegarde JSON régulière.

## Organisation
Les cours sont préchargés depuis la liste fournie. Les systèmes sont des suggestions automatiques par mots-clés : tu peux ajouter tes propres cours et systèmes. Les intitulés d'origine sont conservés.
