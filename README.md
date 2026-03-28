🚀 System Runbook: Blockchain Voting Platform (PoA)
1. Booting Up the Network

Before doing anything, you need to compile the code and start the Podman containers. Because we are using containers, you don't need to manually start MongoDB or Node.js.

    Command: ```bash
    podman-compose up -d --build

    What this does: The --build flag ensures your latest TypeScript code is compiled. The -d (detached) flag runs the 8 containers (4 Node apps, 4 Databases) in the background so your terminal remains free.

    Verification: Open Podman Desktop. You should see all 8 containers showing a green "RUNNING" status.

2. Monitoring the Logs (The "Matrix" View)

To see the P2P network talking and the Validators mining, it is highly recommended to keep the logs open.

    In Podman Desktop: Click on validator1-app and go to the "Logs" tab. Leave this open on a second monitor or side of your screen. You will see the 15-second heartbeat of the consensus loop here.

3. Checking System Health (Gateway)

Ensure your Gateway node is awake and accepting HTTP requests on port 3000.

    Command:
    Bash

    curl http://localhost:3000/

    Expected Output: A JSON response confirming isValidator: "false" and showing the uptime.

4. Viewing the Databases (MongoDB Compass)

You want to visually prove that data is syncing across different nodes.

    Gateway DB: Open Compass, connect to mongodb://localhost:27017, and open the voting_node_db -> blocks collection.

    Validator 1 DB: Open a new tab in Compass, connect to mongodb://localhost:27018.

    (Tip: Use the green "Refresh" or "Find" button next to the query bar to load new blocks without duplicating the connection).

🗳️ Interacting with the Blockchain
5. Casting a Single Signed Vote

Because the network now uses strict cryptographic signatures (ethers.js), you cannot just send a fake JSON string. You must generate a mathematically valid payload first.

Step A: Generate the Vote Payload
Run the utility script Claude built for you to create a random wallet and sign a vote.

    Command:
    Bash

    npx ts-node scripts/generate-voter.ts

    Expected Output: The terminal will spit out a JSON object containing senderPublicKey, candidateId, and the long signature hex string.

Step B: Submit the Vote
Copy the JSON from Step A and use it in a curl POST request to the Gateway.

    Command:
    Bash

    curl -X POST http://localhost:3000/vote \
    -H "Content-Type: application/json" \
    -d '{ 
          "senderPublicKey": "PASTE_KEY_HERE", 
          "candidateId": "Alice_Smith", 
          "signature": "PASTE_SIGNATURE_HERE" 
        }'

    Expected Output: {"message": "Vote added to pending pool"}

6. Observing the Mempool and Consensus

Once you cast the vote, you have a 15-second window to see it waiting in the Mempool before a Validator mines it.

    View the Waiting Room (Mempool):
    Bash

    curl http://localhost:3000/pool

    Watch the Consensus: Look at your Podman Desktop logs for validator1-app. Within 15 seconds, you will see it log: "Mining block with 1 transactions..." followed by a P2P broadcast message.

    View the Final Blockchain:
    Bash

    curl http://localhost:3000/blocks

    (You can also click refresh in MongoDB Compass to see the new block appear).

7. Testing the Security (Double-Voting)

Try running the exact same curl -X POST command from Step 5B a second time.

    Expected Output: The Gateway will reject it with a 400 Bad Request because the State.hasVoted mechanism recognizes the public key.

🔥 The Stress Test (Showstopper Demo)

To simulate a national election and prove your asynchronous Mempool works under heavy load, run the stress test script.

    Command:
    Bash

    npx ts-node scripts/stress-test.ts

    What happens: This script rapidly generates 10 (or however many you configured) unique wallets, signs 10 distinct votes, and fires them at the Gateway.

    The Result: Check http://localhost:3000/pool quickly to see 10 votes queued up. Wait for the 15-second Validator loop, and then check http://localhost:3000/blocks. You will see all 10 votes beautifully packed into a single newly minted Block!

🛑 Shutting Down and Resetting

When you are done developing for the day, or if you want to wipe the blockchain completely clean to start fresh (erasing all MongoDB data):

    Command:
    Bash

    podman-compose down -v

    What this does: Stops all 8 containers and the -v flag destroys the database volumes, ensuring a totally blank slate the next time you boot up.