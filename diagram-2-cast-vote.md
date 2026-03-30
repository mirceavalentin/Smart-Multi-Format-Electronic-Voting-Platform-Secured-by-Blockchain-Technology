sequenceDiagram
    autonumber

    actor Votant as Votant
    participant MM as MetaMask
    participant UI as Interfata Web Votant (index.html)
    participant GW as Nod Gateway (server.ts)
    participant Pool as Mempool (TransactionPool)
    participant V1 as Validator 1
    participant V2 as Validator 2
    participant V3 as Validator 3

    Note over Votant, V3: Faza 1 -- Conectarea portofelului si semnarea votului

    Votant->>UI: Click Conecteaza Portofelul
    UI->>MM: eth_requestAccounts
    MM-->>UI: Adresa portofel (0x...)
    UI-->>Votant: Afiseaza adresa conectata

    Votant->>UI: Selecteaza candidat, click Voteaza

    UI->>UI: Construieste payload canonic (senderPublicKey, candidateId, electionId, timestamp)
    UI->>MM: signer.signMessage(payload)
    MM-->>Votant: Fereastra de semnare MetaMask
    Votant->>MM: Aproba semnatura
    MM-->>UI: Semnatura EIP-191 (0x...)

    UI->>GW: POST /api/vote (payload + semnatura)

    Note over GW: Faza 2 -- Pipeline de validare pe 3 niveluri

    GW->>GW: Nivel 1 -- election.isVoteValid(vote) verifica lista alba, candidat, timp

    alt Votantul NU este pe lista alba SAU candidat invalid
        GW-->>UI: 400 motiv eroare
        UI-->>Votant: Vot respins
    else Trece Nivelul 1
        GW->>GW: Nivel 2 -- electionState.hasVoted(address) verificare vot dublu

        alt Adresa a votat deja
            GW-->>UI: 400 A votat deja
            UI-->>Votant: Vot respins - a votat deja
        else Primul vot de la aceasta adresa
            GW->>GW: Nivel 3 -- ethers.verifyMessage(payload, sig) recuperare ECDSA

            alt Adresa recuperata != senderPublicKey
                GW-->>UI: 400 Semnatura invalida
                UI-->>Votant: Vot respins - semnatura invalida
            else Semnatura valida

                Note over GW, V3: Faza 3 -- Acceptare si difuzare in retea

                GW->>GW: electionState.markVoted(address)
                GW->>Pool: txPool.addTransaction(vote)

                par Difuzare vot catre toti partenerii
                    GW->>V1: BROADCAST_TRANSACTION vote
                    GW->>V2: BROADCAST_TRANSACTION vote
                    GW->>V3: BROADCAST_TRANSACTION vote
                end

                V1->>V1: txPool.addTransaction(vote)
                V2->>V2: txPool.addTransaction(vote)
                V3->>V3: txPool.addTransaction(vote)

                GW-->>UI: 200 Vot acceptat
                UI-->>Votant: Vot inregistrat
            end
        end
    end
