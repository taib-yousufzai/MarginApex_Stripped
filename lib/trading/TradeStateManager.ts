import { getAdminClient } from '@/lib/adminClient';

export type TradeState = 'PENDING' | 'EXECUTED' | 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'REJECTED' | 'FAILED';

export class TradeStateManager {
  /**
   * Transitions an order from PENDING to EXECUTED/REJECTED.
   * If the transition is valid, updates the order in the database.
   */
  static async transitionOrderState(orderId: string, currentState: TradeState, newState: TradeState, reason?: string): Promise<void> {
    const admin = getAdminClient();

    // 1. Strict Transition Validations
    if (currentState === 'PENDING') {
      if (newState !== 'EXECUTED' && newState !== 'REJECTED') {
        throw new Error(`Invalid transition from PENDING to ${newState}`);
      }
    } else if (currentState === 'EXECUTED') {
      if (newState !== 'OPEN' && newState !== 'FAILED') {
        throw new Error(`Invalid transition from EXECUTED to ${newState}`);
      }
    } else if (currentState === 'OPEN') {
      if (newState !== 'PARTIALLY_CLOSED' && newState !== 'CLOSED') {
        throw new Error(`Invalid transition from OPEN to ${newState}`);
      }
    } else if (currentState === 'PARTIALLY_CLOSED') {
      if (newState !== 'CLOSED' && newState !== 'PARTIALLY_CLOSED') {
        throw new Error(`Invalid transition from PARTIALLY_CLOSED to ${newState}`);
      }
    } else {
      throw new Error(`Cannot transition from a terminal state: ${currentState}`);
    }

    // 2. Perform DB update
    const { error } = await admin
      .from('orders')
      .update({ status: newState, info: reason || null })
      .eq('id', orderId);

    if (error) {
      throw new Error(`Database error transitioning order state: ${error.message}`);
    }
  }

  /**
   * Handles rollback of an order if position opening fails.
   * Marks the order as FAILED to indicate a systemic failure, ensuring the ledger
   * does not fall out of sync with open positions.
   */
  static async rollbackFailedExecution(orderId: string, errorMessage: string): Promise<void> {
    const admin = getAdminClient();

    await admin
      .from('orders')
      .update({ status: 'FAILED', info: `System Rollback: ${errorMessage}` })
      .eq('id', orderId);
      
    // Note: If margin was deducted prior to this step (e.g. at PENDING state),
    // a refund function would be invoked here. However, since 'place_order' RPC handles
    // margin deduction and position opening atomically in Postgres, a failure means
    // no margin was ever deducted. We just mark the order as FAILED.
  }
}
