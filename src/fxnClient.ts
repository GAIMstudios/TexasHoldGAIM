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
        // Make sure we are subscribed to the GAIM host
        const subscriptions = await this.getSubscriptions();
        const subscribed = subscriptions.find((subscription) => {
            return subscription.dataProvider.toString() == this.hostPublicKey.toString();
        });

        assert(subscribed, `You are not subscribed to the GAIM host. Subscribe to the provider with public key ${this.hostPublicKey} at https://fxn.world/superswarm`);
        console.log(`Player initialized. Subscribed to GAIM host with public key ${subscribed.dataProvider}.`);
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
