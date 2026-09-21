
# INSTRUKSER
Ikke rør testene som er skrevet. Bruk dem som de er.
Dokumentasjon på apiet vi bruker ligger her. https://psapi.nrk.no/documentation/  Bare undersøk api om STRENGT NØDVENDIG.
Nå skal vi ikke endre public-api, eller NrkClient sine returverdier. Bare implementasjonen.

# Formål
- Typesikker klient for NRK-apiet.
- Skal publiseres som en npm pakke.
- Pakken skal ha et enkelt og pent Public-api.
- Andre applikasjoner skal kunne bruke
- Klienten som eksporteres skal brukes av AI til å lage spillelister for demente.
- AI vil bruke dataene til å lage personaliserte spillelister for demente.

# Kode-design.
- Bare jobb i main branch
- Vanilla js
- Koden skal kunne kjøre både i nodejs og i browser
- Bruk arrow-functions
- Public-Api skal være typesikker og her skal vi validere alle returverdier.
- Ikke github-action - Jeg vil publisere pakkene selv.
- I denne fasen skal pakkene ha versjon 0.x.x
- Pakken skal bare eksportere EN KLIENT, og den skal hete NrkClient
- NrkClient skal aldri kaste feil, men returnere feil som verdier
- NrkClient skal være stateless, ikke lagre data i minne, bare hente data og validere