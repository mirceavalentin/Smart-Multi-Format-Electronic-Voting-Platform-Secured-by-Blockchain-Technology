sequenceDiagram
    autonumber

    actor Admin as Administrator
    participant UI as Interfata Web Admin (admin.html)
    participant GW as Nod Gateway (server.ts)
    participant DB as MongoDB
    participant V1 as Validator 1
    participant V2 as Validator 2
    participant V3 as Validator 3

    Note over Admin, V3: Faza 1 -- Administratorul trimite configuratia alegerilor

    Admin->>UI: Completeaza candidati, lista alba, durata
    UI->>GW: POST /api/election

    GW->>GW: Valideaza datele de intrare
    GW->>GW: Construieste ElectionConfig (electionId, endTime, isActive)
    GW->>GW: election.activate(config)

    Note over GW, V3: Faza 2 -- Difuzare catre Validatori prin P2P WebSocket

    par Difuzare catre toti partenerii
        GW->>V1: ELECTION_CREATED config
        GW->>V2: ELECTION_CREATED config
        GW->>V3: ELECTION_CREATED config
    end

    V1->>V1: election.activate(config)
    V2->>V2: election.activate(config)
    V3->>V3: election.activate(config)

    Note over GW: Faza 3 -- Programarea cronometrului de stergere automata

    GW->>GW: setTimeout(autoWipe, durationSeconds x 1000)

    GW-->>UI: 201 Alegeri create
    UI-->>Admin: Afiseaza Alegeri create cu succes
