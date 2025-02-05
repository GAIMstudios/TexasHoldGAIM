import { SolanaAdapter, SubscriberDetails } from 'fxn-protocol-sdk';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, TransactionSignature } from '@solana/web3.js';
import bs58 from 'bs58';
import { AgentParams, SubscriptionDetails } from "fxn-protocol-sdk/dist/client/fxn-solana-adapter";
import assert from "assert";

export enum BroadcastType {
    Ping, // No content, expects a 200 response
    Query, // Has content, expects a 200 response with request body filled
}

export interface BroadcastPayload {
    type: BroadcastType,
    content?: Object
}

export class FxnClient {
    private solanaAdapter: SolanaAdapter;
    private hostPublicKey: PublicKey;

    constructor() {
        const provider = this.createAnchorProvider();
        this.solanaAdapter = new SolanaAdapter(provider);
        this.hostPublicKey = new PublicKey(process.env.GAIM_HOST_PUBLIC_KEY!);
    }

    public async initializePlayer() {
        // Find our gamemaster
        const hostDetails = await this.getHostParams();
        assert(hostDetails, `Error: Failed to find GAIM host with key ${this.hostPublicKey.toString()}`);

        console.log("Found gamemaster: " + hostDetails.name);

        // Subscribe to the host or renew our subscription
        const subscriptions = await this.getSubscriptions();
        const subscribed = subscriptions.find((subscription) => {
            return subscription.dataProvider.toString() == this.hostPublicKey.toString();
        });

        if (!subscribed) {
            console.log("Subscribing to host.");
            await this.subscribeToHost();
        } else {
            console.log("Already subscribed to host.");
        }
    }

    public async getHostParams(): Promise<AgentParams | undefined> {
        try {
            return await this.solanaAdapter.getAgentDetails(this.hostPublicKey);
        } catch (error: any) {
            console.log("Failed to find host", this.hostPublicKey.toString(), error);
        }
    }
    
    public async subscribeToHost(): Promise<TransactionSignature | undefined> {
        const hostParams = await this.getHostParams();
        assert(hostParams);

        if (hostParams.restrictSubscriptions) {
            // Request a subscription
            const subscriptionSig =  await this.solanaAdapter.requestSubscription({dataProvider: this.hostPublicKey});
            console.log("Requested subscription", subscriptionSig);
            return subscriptionSig;
        } else {
            // Create a subscription
            assert(process.env.GAIM_PLAYER_URL, "GAIM_PLAYER_URL not set in .env");
            
            const [subSig, _] = await this.solanaAdapter.createSubscription({
                dataProvider: this.hostPublicKey,
                recipient: process.env.GAIM_PLAYER_URL,
                durationInDays: 1
            });

            console.log("Created subscription", subSig);
            return subSig;
        }
    }

    public async unsubscribeFromHost(): Promise<TransactionSignature[]> {
        const unsubSig = await this.solanaAdapter.cancelSubscription({
            dataProvider: this.hostPublicKey,
            qualityScore: 100
        });

        console.log("Unsubscribed from host.", unsubSig);
        return unsubSig;
    }

    public async getHostSubscribers(): Promise<SubscriberDetails[]> {
        return await this.solanaAdapter.getSubscriptionsForProvider(this.hostPublicKey)
            .catch((error) => {
                console.error("Error getting host subscribers:", error);
                return [];
            });
    }

    public async getSubscriptions(): Promise<SubscriptionDetails[]> {
        const agentId = new PublicKey(process.env.WALLET_PUBLIC_KEY!);
        return await this.solanaAdapter.getAllSubscriptionsForUser(agentId)
            .catch((error) => {
                console.error("Error getting subscriptions:", error);
                return [];
            });
    }

    protected createAnchorProvider(): AnchorProvider {
        const rpcUrl = process.env.RPC_URL;
        assert(rpcUrl, "RPC_URL not provided in .env");
        const privateKey = process.env.WALLET_PRIVATE_KEY;
        assert(privateKey, "WALLET_PRIVATE_KEY not provided in .env");

        // Convert base58 private key to Uint8Array
        const privateKeyUint8Array = bs58.decode(privateKey);

        // Create keypair from private key
        const keypair = Keypair.fromSecretKey(privateKeyUint8Array);

        // Create connection using the RPC URL
        const connection = new Connection(rpcUrl, 'confirmed');

        // Create wallet instance
        const wallet = new Wallet(keypair);

        // Create and return the provider
        return new AnchorProvider(
            connection,
            wallet,
            { commitment: 'confirmed' }
        );
    }
}
