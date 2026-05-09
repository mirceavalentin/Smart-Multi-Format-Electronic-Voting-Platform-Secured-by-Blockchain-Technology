graph TD
    START([Pornirea Sistemului]) --> BOOT[Conectare la MongoDB, Persistare Genesis Block, Pornire servere P2P + HTTP]
    BOOT --> IDLE[Inactiv - Nicio alegere in desfasurare]

    IDLE --> CREATE[Administratorul trimite configuratia prin POST /api/election]
    CREATE --> ACTIVATE[Gateway activeaza Election si difuzeaza ELECTION_CREATED catre Validatori]
    ACTIVATE --> TIMER[Cronometrul de stergere automata programat prin setTimeout]
    TIMER --> VOTING[Faza de Votare Deschisa]

    VOTING --> CONNECT{Votantul conecteaza portofelul MetaMask?}
    CONNECT -- Nu --> VOTING
    CONNECT -- Da --> SUBMIT[Votantul selecteaza candidatul si semneaza buletinul cu MetaMask]

    SUBMIT --> WL{Votantul este pe lista alba?}
    WL -- Nu --> REJECT1[Respins - Eroare 400]
    REJECT1 --> VOTING

    WL -- Da --> DUP{Votantul a votat deja?}
    DUP -- Da --> REJECT2[Respins - A votat deja]
    REJECT2 --> VOTING

    DUP -- Nu --> SIG{Semnatura ECDSA valida?}
    SIG -- Nu --> REJECT3[Respins - Semnatura invalida]
    REJECT3 --> VOTING

    SIG -- Da --> ACCEPT[Vot acceptat in Mempool si difuzat catre toti partenerii]

    ACCEPT --> MINING{Ciclul de minare al Validatorului la fiecare 15 secunde}
    MINING -- Mempool gol --> MINING
    MINING -- Voturi in asteptare --> MINE[Golire Mempool, Minare bloc nou cu SHA-256, Persistare in MongoDB]
    MINE --> BROADCAST[Difuzare bloc catre toti partenerii]
    BROADCAST --> SYNC[Partenerii sincronizeaza lantul - Adaugare sau Inlocuire]
    SYNC --> VOTING

    VOTING --> EXPIRED{Cronometrul a expirat?}
    EXPIRED -- Nu --> VOTING
    EXPIRED -- Da --> TALLY[Numararea voturilor din blockchain-ul imuabil]

    TALLY --> WIPE[Stergere automata: Stergere blocuri din MongoDB, Resetare lant la Genesis, Golire Mempool + Set Votanti]
    WIPE --> DEACTIVATE[Dezactivare alegeri, Re-persistare Genesis Block]
    DEACTIVATE --> RESULTS[Rezultate disponibile prin GET /api/election/results]
    RESULTS --> IDLE

    style START fill:#1e293b,stroke:#60a5fa,color:#f1f5f9
    style IDLE fill:#1e293b,stroke:#60a5fa,color:#f1f5f9
    style VOTING fill:#065f46,stroke:#34d399,color:#f1f5f9
    style ACCEPT fill:#065f46,stroke:#34d399,color:#f1f5f9
    style MINE fill:#7c3aed,stroke:#a78bfa,color:#f1f5f9
    style BROADCAST fill:#7c3aed,stroke:#a78bfa,color:#f1f5f9
    style SYNC fill:#7c3aed,stroke:#a78bfa,color:#f1f5f9
    style TALLY fill:#92400e,stroke:#fbbf24,color:#f1f5f9
    style WIPE fill:#991b1b,stroke:#f87171,color:#f1f5f9
    style DEACTIVATE fill:#991b1b,stroke:#f87171,color:#f1f5f9
    style RESULTS fill:#1e293b,stroke:#60a5fa,color:#f1f5f9
    style REJECT1 fill:#7f1d1d,stroke:#ef4444,color:#f1f5f9
    style REJECT2 fill:#7f1d1d,stroke:#ef4444,color:#f1f5f9
    style REJECT3 fill:#7f1d1d,stroke:#ef4444,color:#f1f5f9
