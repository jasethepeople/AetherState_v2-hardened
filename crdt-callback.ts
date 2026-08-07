import { BaseCallbackHandler } from 'langchain/callbacks';
import { Y.Doc, Map as YMap } from 'yjs';
import winston from 'winston';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-crdt-callback' },
    transports: [new winston.transports.Console()]
});

interface CRDTCallbackConfig {
    doc: Y.Doc;
    agentId: string;
    pathPrefix?: string;
    maxEntrySize?: number;
    maxHistoryEntries?: number;
    enableCompression?: boolean;
}

interface SafeSerializationResult {
    data: string;
    wasTruncated: boolean;
    originalSize: number;
}

class CRDTCallbackHandler extends BaseCallbackHandler {
    name = 'aetherstate_crdt_callback';
    private doc: Y.Doc;
    private agentId: string;
    private pathPrefix: string;
    private maxEntrySize: number;
    private maxHistoryEntries: number;
    private yMap: YMap<any>;
    private operationCount = 0;

    constructor(config: CRDTCallbackConfig) {
        super();
        this.doc = config.doc;
        this.agentId = config.agentId;
        this.pathPrefix = config.pathPrefix || 'agents';
        this.maxEntrySize = config.maxEntrySize || 1024 * 1024;
        this.maxHistoryEntries = config.maxHistoryEntries || 1000;

        const rootMap = this.doc.getMap('agents');
        if (!rootMap.has(this.agentId)) {
            rootMap.set(this.agentId, new Y.Doc());
        }

        const agentDoc = rootMap.get(this.agentId) as Y.Doc;
        this.yMap = agentDoc.getMap('history');
    }

    async onChainStart(serialized: any, inputs: any): Promise<void> {
        try {
            const safeInputs = this.safeSerialize(inputs);
            const timestamp = Date.now();
            const entryId = `chain_input_${timestamp}_${this.operationCount++}`;

            const entry = {
                type: 'chain_input',
                timestamp,
                data: safeInputs.data,
                wasTruncated: safeInputs.wasTruncated,
                originalSize: safeInputs.originalSize
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();

            logger.debug('Chain start recorded', { 
                agentId: this.agentId, 
                entryId,
                wasTruncated: safeInputs.wasTruncated 
            });
        } catch (err) {
            logger.error('Failed to record chain start', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    async onChainEnd(outputs: any): Promise<void> {
        try {
            const safeOutputs = this.safeSerialize(outputs);
            const timestamp = Date.now();
            const entryId = `chain_output_${timestamp}_${this.operationCount++}`;

            const entry = {
                type: 'chain_output',
                timestamp,
                data: safeOutputs.data,
                wasTruncated: safeOutputs.wasTruncated,
                originalSize: safeOutputs.originalSize
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();

            logger.debug('Chain end recorded', { 
                agentId: this.agentId, 
                entryId,
                wasTruncated: safeOutputs.wasTruncated 
            });
        } catch (err) {
            logger.error('Failed to record chain end', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    async onLLMStart(serialized: any, prompts: string[]): Promise<void> {
        try {
            const timestamp = Date.now();
            const entryId = `llm_start_${timestamp}_${this.operationCount++}`;

            const truncatedPrompts = prompts.map(p => 
                p.length > 10000 ? p.substring(0, 10000) + '...[truncated]' : p
            );

            const entry = {
                type: 'llm_start',
                timestamp,
                prompts: truncatedPrompts,
                promptCount: prompts.length
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();
        } catch (err) {
            logger.error('Failed to record LLM start', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    async onLLMEnd(response: any): Promise<void> {
        try {
            const timestamp = Date.now();
            const entryId = `llm_end_${timestamp}_${this.operationCount++}`;

            const generations = response.generations || [];
            const safeGenerations = generations.map((gen: any) => ({
                text: gen.text?.substring(0, 50000) || '',
                generationInfo: gen.generationInfo || {}
            }));

            const entry = {
                type: 'llm_end',
                timestamp,
                generations: safeGenerations,
                llmOutput: response.llmOutput ? '[present]' : '[absent]'
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();
        } catch (err) {
            logger.error('Failed to record LLM end', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    async onToolStart(serialized: any, input: string): Promise<void> {
        try {
            const timestamp = Date.now();
            const entryId = `tool_start_${timestamp}_${this.operationCount++}`;

            const entry = {
                type: 'tool_start',
                timestamp,
                tool: serialized.name || 'unknown',
                input: input.substring(0, 10000)
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();
        } catch (err) {
            logger.error('Failed to record tool start', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    async onToolEnd(output: string): Promise<void> {
        try {
            const timestamp = Date.now();
            const entryId = `tool_end_${timestamp}_${this.operationCount++}`;

            const entry = {
                type: 'tool_end',
                timestamp,
                output: output.substring(0, 10000)
            };

            this.yMap.set(entryId, entry);
            this.enforceRetentionPolicy();
        } catch (err) {
            logger.error('Failed to record tool end', {
                agentId: this.agentId,
                error: (err as Error).message
            });
        }
    }

    private safeSerialize(data: any): SafeSerializationResult {
        const originalSize = JSON.stringify(data).length;

        try {
            const seen = new WeakSet();
            const safeData = JSON.parse(JSON.stringify(data, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (seen.has(value)) {
                        return '[Circular Reference]';
                    }
                    seen.add(value);
                }
                return value;
            }));

            let serialized = JSON.stringify(safeData);
            let wasTruncated = false;

            if (serialized.length > this.maxEntrySize) {
                serialized = serialized.substring(0, this.maxEntrySize) + '...[truncated]';
                wasTruncated = true;
                logger.warn('Data truncated', {
                    agentId: this.agentId,
                    originalSize,
                    maxSize: this.maxEntrySize
                });
            }

            return {
                data: serialized,
                wasTruncated,
                originalSize
            };
        } catch (err) {
            logger.error('Serialization failed', {
                agentId: this.agentId,
                error: (err as Error).message
            });

            return {
                data: JSON.stringify({
                    error: 'Failed to serialize',
                    type: typeof data,
                    keys: Object.keys(data || {})
                }),
                wasTruncated: true,
                originalSize
            };
        }
    }

    private enforceRetentionPolicy(): void {
        const entries = Array.from(this.yMap.entries());

        if (entries.length > this.maxHistoryEntries) {
            const sorted = entries.sort((a, b) => {
                const timeA = (a[1] as any).timestamp || 0;
                const timeB = (b[1] as any).timestamp || 0;
                return timeA - timeB;
            });

            const toRemove = sorted.slice(0, entries.length - this.maxHistoryEntries);
            toRemove.forEach(([key]) => {
                this.yMap.delete(key);
            });

            logger.info('Retention policy enforced', {
                agentId: this.agentId,
                removed: toRemove.length,
                remaining: this.maxHistoryEntries
            });
        }
    }

    getHistory(): Array<{ id: string; entry: any }> {
        return Array.from(this.yMap.entries()).map(([id, entry]) => ({
            id,
            entry
        }));
    }

    getStats(): { totalEntries: number; operationCount: number } {
        return {
            totalEntries: this.yMap.size,
            operationCount: this.operationCount
        };
    }

    clearHistory(): void {
        const keys = Array.from(this.yMap.keys());
        keys.forEach(key => this.yMap.delete(key));
        logger.info('History cleared', { agentId: this.agentId });
    }
}

export { CRDTCallbackHandler, CRDTCallbackConfig, SafeSerializationResult };
