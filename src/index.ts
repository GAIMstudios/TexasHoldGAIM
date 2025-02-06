import 'dotenv/config'
import assert from 'assert';
import cors from 'cors'
import express, { Request, Response } from 'express';
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { BroadcastType, FxnClient } from './fxnClient';
import { SignedMessage, verifyMessage } from './utils/signingUtils';

interface Card {
    rank: string // '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A'
    suit: string // 'clubs' | 'diamonds' | 'hearts' | 'spades'
 }

interface TableState {
    forcedBets: { ante: number, bigBlind: number, smallBlind: number },
    pots: Array<number>, // The amount of chips in each pot
    biggestBet: number, // The biggest bet so far this betting round
    communityCards: Array<Card>,
}

interface PlayerState {
    name: string,
    holeCards: Array<Card>,
    currentBet: number, // The amount of chips you have wagered this betting round
    stack: number, // Your total chips - your current bet
    inPots: number[], // The index(s) of the tableState.pots[] you are eligible to win
    legalActions: LegalActions
}

interface LegalActions {
    actions: string[], // 'fold' | 'check' | 'call' | 'bet' | 'raise'
    chipRange?: { // The minimum and maximum bet, if action is bet or raise
        min: number,
        max: number
    }
}

interface ActionHistoryEntry {
    roundOfBetting: string, 
    name: string, 
    action: string, 
    betSize: number
}

declare type ActionHistory = Array<ActionHistoryEntry>

interface PokerPayload {
    tableState: TableState,
    playerState: PlayerState,
    actionHistory: ActionHistory
}

class GAIMClientInterface {
    private app: express.Express;
    private fxnClient: FxnClient;
    private model; // ChatOpenAI

    constructor() {
        this.app = express();
        this.app.use(express.json());

        this.fxnClient = new FxnClient();

        // Define the response schema
        const pokerResponse = z.object({
            action: z.enum(['fold', 'check', 'call', 'bet', 'raise']).describe("Your chosen action."),
            betSize: z.number().describe("Your chosen bet size. If you chose to fold, check, or call, this should be 0."),
            explanation: z.string().describe("A brief explanation of the reasons behind your decision.")
        });

        this.model = new ChatOpenAI({model: "gpt-4o-mini"}).withStructuredOutput(pokerResponse);

        const allowedOrigin = '*'; // Define your frontend origin
        this.app.use(cors({
            origin: allowedOrigin,
            methods: ['GET', 'POST'],
            credentials: true
        }));

        this.setupGame();
    }

    private async setupGame() {
        await this.fxnClient.initializePlayer();
        
        this.setupRoutes();

        const port = process.env.SERVER_PORT || 3000;
        this.app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    }

    private setupRoutes() {
        console.log('Setting up routes for player');
        const handleRequest = async (req: any, res: any) => {
            try {
                const { signature, payload } = req.body as SignedMessage;

                // Get the game master's public key
                const gameMasterKey = process.env.GAIM_HOST_PUBLIC_KEY;
                assert(gameMasterKey, "GAIM_HOST_PUBLIC_KEY not provided in .env");

                // Verify that the message came from the game master
                const verificationResult = await verifyMessage({
                    payload,
                    signature,
                    publicKey: gameMasterKey
                });

                if (!verificationResult.isValid) {
                    return res.status(401).json({
                        error: 'Invalid signature',
                        details: 'Message signature verification failed'
                    });
                }

                // If this is just a ping, respond with 200
                if (payload.type == BroadcastType.Ping) {
                    return res.send("Got ping");
                }

                const pokerPayload = payload.content as PokerPayload;

                // Generate an action based on the board state
                const tableState: TableState = pokerPayload.tableState;
                const playerState: PlayerState = pokerPayload.playerState;
                const actionHistory: ActionHistory = pokerPayload.actionHistory;

                // Get legal actions
                const legalActions = playerState.legalActions;
                console.log("Legal Actions:", legalActions.actions);
                if (legalActions.chipRange)
                    console.log(`Bet Range: ${legalActions.chipRange?.min} -> ${legalActions.chipRange?.max}\n`);

                // Determine an action to take and a bet size if applicable
                const prompt = this.generatePokerPrompt(tableState, playerState, actionHistory);
                const output = await this.model.invoke(prompt);

                console.log("Parsed action:", output.action);
                console.log("Parsed betSize:", output.betSize);
                console.log(`Explanation:\n${output.explanation}\n`);

                // Include it in the response
                return res.json({
                    action: output.action,
                    betSize: output.betSize
                });

            } catch (error: any) {
                console.error('Error processing request:', error);
                res.status(500).json({
                    error: 'Internal server error',
                    details: error.message
                });
            }
        };

        // Register the handler for both paths
        this.app.post('/', handleRequest);
        this.app.post('', handleRequest);
    }

    private generatePokerPrompt(tableState: TableState, playerState: PlayerState, actionHistory: ActionHistory): string {
        
        const formatCards = (cards: {rank: string, suit: string}[]): string => {
            const cardStrings = cards.map((card) => {
                return `${card.rank} of ${card.suit}`;
            });

            return cardStrings.join(", ");
        }

        const formatActionHistory = (actionHistory: ActionHistory): string => {
            const actionStrings = this.getActionHistoryStrings(actionHistory);

            return actionStrings.join(", ");
        }

        const legalActions = playerState.legalActions;
        
        return `
            Your name is ${playerState.name}, and you are a poker agent playing Texas Hold'em.

            Assess the current situation and decide what kind of action to take.
            If applicable, also decide the size of bet to make.

            Your current properties are:
            - Chips: ${playerState.stack}
            - Hand: [${formatCards(playerState.holeCards)}]
            - Current Bet: ${playerState.currentBet}

            Take into account the table's community cards and biggest bet to make your decision.
            - Community Cards: [${formatCards(tableState.communityCards)}]
            - Biggest Bet: ${tableState.biggestBet}

            Review the action history and opponent behavior to inform your decision:
            - Action History: [${formatActionHistory(actionHistory)}]

            If there are no entries in the Action History, you are the first player to act in this round,

            Based on this information, decide on a legal action from the following list:
            - Legal Actions: [${legalActions.actions.join(", ")}]
            ${legalActions.chipRange ? `If you choose a legal action that requires a bet size, it must be a minimum of ${legalActions.chipRange?.min} dollars and a maximum of ${legalActions.chipRange?.max} dollars.` : ``}

            The basic strategy behind each type of action is as follows:
            - Fold: If your hand is weak and opponents show strength. Does not require a bet size.
            - Call: If your current bet is less than the biggest bet, but the biggest bet value is reasonable and your hand has potential. Does not require a bet size.
            - Check: If your current bet is equal to the biggest bet, and you want to see the next card for free. Does not require a bet size.
            - Raise: If your current bet is less than the biggest bet, but your hand is strong and you want to increase the pot size or bluff. Requires a bet size.
            - Bet: If your current bet is equal to the biggest bet, but your hand is strong and you want to increase the pot size or bluff. Requires a bet size.

            Respond with an action from the Legal Actions list, a valid bet size, and a brief explanation of the reasons behind your decision.
        `;
    }

    private getActionHistoryStrings(actionHistory: ActionHistory) {
        return actionHistory.map((entry: ActionHistoryEntry) => {
            const name = entry.name.length > 8 ? entry.name.substring(0, 8) : entry.name;
            return `During the ${entry.roundOfBetting}, ${name} ${entry.action}s ${entry.betSize ? entry.betSize : ""}`;
        });
    }
}

new GAIMClientInterface();