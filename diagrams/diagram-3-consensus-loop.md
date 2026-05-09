sequenceDiagram
    autonumber

    participant Timer as setInterval (ciclu 15s)
    participant Val as Nod Validator (server.ts)
    participant Pool as Mempool (TransactionPool)
    participant Chain as Blockchain
    participant DB as MongoDB
    participant Peers as Toti partenerii (Gateway + Validatori)

    Note over Timer, Peers: Se repeta la fiecare 15 secunde (VALIDATOR_INTERVAL_MS)

    Timer->>Val: Ciclul de minare se declanseaza

    Val->>Pool: txPool.size

    alt Mempool-ul este gol
        Pool-->>Val: 0
        Note over Val: Se omite -- nimic de minat
    else Mempool-ul contine voturi in asteptare
        Pool-->>Val: numar gt 0

        Val->>Pool: getTransactions()
        Pool-->>Val: Vote[] copie

        Val->>Pool: clearPool()

        Note over Val, Chain: Minarea unui bloc nou

        Val->>Chain: blockchain.addBlock(votes)
        Chain->>Chain: Creeaza Block (index, timestamp, votes, previousHash, SHA-256)
        Chain-->>Val: newBlock

        Note over Val, DB: Persistare in MongoDB

        Val->>DB: BlockModel.create(newBlock)
        DB-->>Val: Confirmat

        Note over Val, Peers: Difuzarea blocului minat

        Val->>Peers: RESPONSE_BLOCKCHAIN newBlock

        Peers->>Peers: chainSyncService.handleBlockchainResponse()

        alt Blocul extinde lantul cu +1
            Peers->>Peers: Adauga bloc (cale rapida)
            Peers->>DB: Upsert bloc dupa index
        else Lantul primit este mai lung
            Peers->>Peers: Solicita lantul complet (QUERY_ALL)
            Peers->>Peers: Valideaza si inlocuieste lantul local
            Peers->>DB: Persista lantul complet
        else Blocul este invechit
            Note over Peers: Se ignora
        end
    end
