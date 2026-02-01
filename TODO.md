# TODO - Badly

## Haute priorite

### Injection HTML via noms de participants
Dans `index.html:1409`, les noms de participants sont inseres via `innerHTML` sans echappement. Cote serveur (`server.js:800-815`), `handleUpdateParticipants` valide les noms avec seulement une verification de longueur (max 20 chars), pas de regex. La limite de 20 caracteres empeche l'execution de JavaScript (les vecteurs XSS classiques depassent 20 chars et `<svg onload=...>` ne se declenche pas via `innerHTML`), mais permet l'injection de HTML arbitraire (balises `<b>`, `<a href=...>`, etc.) ce qui peut alterer le rendu ou inserer des liens malveillants.

**Correction serveur** : ajouter une regex sur les noms de participants (comme pour les usernames).
**Correction frontend** : utiliser `textContent` au lieu de `innerHTML` pour les lignes de participants/followers.

### Webhook deploy sans authentification
`server.js:1453` - le endpoint `POST /webhook/deploy` n'a aucune verification. N'importe qui peut declencher un `git reset --hard` + restart du service. Ajouter une verification de secret (ex: `X-Hub-Signature` de GitHub Actions ou un header/token custom).

## Moyenne priorite

### Pas de notification a la suppression d'une session
`handleDeleteSession` (`server.js:589-629`) supprime la session sans prevenir les participants ni les followers. Un organisateur peut supprimer une session a laquelle des gens se sont inscrits sans qu'ils soient notifies.

### Le refresh detruit l'etat du chat
`renderSessions()` (`index.html:1368`) fait `list.innerHTML = ''` puis reconstruit tout. Cela ferme les `<details>` du chat s'ils etaient ouverts, perd la position de scroll dans les messages. Le polling toutes les 60s aggrave le probleme.

## Faible priorite

### Prix sans borne superieure cote serveur
`server.js:550-551` verifie seulement `price < 0`. Le frontend a `max="200"` mais cote serveur rien n'empeche d'envoyer un prix enorme via une requete directe.

### Code de validation duplique entre create et edit
`handleCreateSession` (`server.js:485-587`) et `handleEditSession` (`server.js:1019-1134`) contiennent ~50 lignes de validation identique. Extraire une fonction `validateSessionPayload(payload, data)`.

### participantCount plafonne artificiellement
`server.js:322` - `Math.min(session.participants.length + 1, session.capacity)` masque un eventuel depassement de capacite. Si par un bug il y a plus de participants que la capacite, l'affichage ne le montre pas.

### Push subscriptions actives apres signout
`handleSignout` (`server.js:442-444`) ne fait que supprimer le cookie. Les subscriptions push restent actives dans `data.json`. L'utilisateur continue de recevoir des notifications apres deconnexion.

### Hash transite a chaque page load
`index.html:1793` - a chaque ouverture de page, `restoreAuth()` appelle `POST /signin` avec le `passwordHash` stocke dans le cookie. Un mecanisme de session token serait plus propre.
