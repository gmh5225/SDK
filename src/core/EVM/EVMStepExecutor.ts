import type {
  ExtendedTransactionInfo,
  FullStatusData,
  Process,
} from '@lifi/types'
import type {
  Hash,
  PublicClient,
  SendTransactionParameters,
  WalletClient,
} from 'viem'
import { publicActions } from 'viem'
import { config } from '../../config.js'
import { getStepTransaction } from '../../services/api.js'
import {
  getTransactionFailedMessage,
  isZeroAddress,
} from '../../utils/index.js'
import { ValidationError, TransactionError } from '../../errors/errors.js'
import { LiFiErrorCode } from '../../errors/constants.js'
import { parseEVMErrors } from './parseEVMErrors.js'
import { BaseStepExecutor } from '../BaseStepExecutor.js'
import { checkBalance } from '../checkBalance.js'
import { getSubstatusMessage } from '../processMessages.js'
import { stepComparison } from '../stepComparison.js'
import type {
  LiFiStepExtended,
  StepExecutorOptions,
  TransactionParameters,
} from '../types.js'
import { waitForReceivingTransaction } from '../waitForReceivingTransaction.js'
import { checkAllowance } from './checkAllowance.js'
import { updateMultisigRouteProcess } from './multisig.js'
import { switchChain } from './switchChain.js'
import type { MultisigConfig, MultisigTransaction } from './types.js'
import { getMaxPriorityFeePerGas } from './utils.js'
import { waitForTransactionReceipt } from './waitForTransactionReceipt.js'

export interface EVMStepExecutorOptions extends StepExecutorOptions {
  walletClient: WalletClient
  multisig?: MultisigConfig
}

export class EVMStepExecutor extends BaseStepExecutor {
  private walletClient: WalletClient
  private multisig?: MultisigConfig

  constructor(options: EVMStepExecutorOptions) {
    super(options)
    this.walletClient = options.walletClient
    this.multisig = options.multisig
  }

  // Ensure that we are using the right chain and wallet when executing transactions.
  checkWalletClient = async (
    step: LiFiStepExtended,
    process?: Process
  ): Promise<WalletClient | undefined> => {
    const updatedWalletClient = await switchChain(
      this.walletClient,
      this.statusManager,
      step,
      this.allowUserInteraction,
      this.executionOptions?.switchChainHook
    )
    if (updatedWalletClient) {
      this.walletClient = updatedWalletClient
    }

    // Prevent execution of the quote by wallet different from the one which requested the quote
    if (this.walletClient.account?.address !== step.action.fromAddress) {
      let processToUpdate = process
      if (!processToUpdate) {
        // We need to create some process if we don't have one so we can show the error
        processToUpdate = this.statusManager.findOrCreateProcess(
          step,
          'TRANSACTION'
        )
      }
      const errorMessage =
        'The wallet address that requested the quote does not match the wallet address attempting to sign the transaction.'
      this.statusManager.updateProcess(step, processToUpdate.type, 'FAILED', {
        error: {
          code: LiFiErrorCode.WalletChangedDuringExecution,
          message: errorMessage,
        },
      })
      this.statusManager.updateExecution(step, 'FAILED')
      throw await parseEVMErrors(
        new TransactionError(
          LiFiErrorCode.WalletChangedDuringExecution,
          errorMessage
        ),
        step,
        process
      )
    }
    return updatedWalletClient
  }

  executeStep = async (step: LiFiStepExtended): Promise<LiFiStepExtended> => {
    step.execution = this.statusManager.initExecutionObject(step)

    // Find if it's bridging and the step is waiting for a transaction on the receiving chain
    const recievingChainProcess = step.execution?.process.find(
      (process) => process.type === 'RECEIVING_CHAIN'
    )

    // Make sure that the chain is still correct
    // If the step is waiting for a transaction on the receiving chain, we do not switch the chain
    // All changes are already done from the source chain
    // Return the step
    if (recievingChainProcess?.substatus !== 'WAIT_DESTINATION_TRANSACTION') {
      const updatedWalletClient = await this.checkWalletClient(step)
      if (!updatedWalletClient) {
        return step
      }
    }

    const isMultisigWalletClient = !!this.multisig?.isMultisigWalletClient
    const multisigBatchTransactions: MultisigTransaction[] = []

    const shouldBatchTransactions =
      this.multisig?.shouldBatchTransactions &&
      !!this.multisig.sendBatchTransaction

    const fromChain = await config.getChainById(step.action.fromChainId)
    const toChain = await config.getChainById(step.action.toChainId)

    const isBridgeExecution = fromChain.id !== toChain.id
    const currentProcessType = isBridgeExecution ? 'CROSS_CHAIN' : 'SWAP'

    // STEP 1: Check allowance
    const existingProcess = step.execution.process.find(
      (p) => p.type === currentProcessType
    )

    // Check token approval only if fromToken is not the native token => no approval needed in that case
    const checkForAllowance =
      !existingProcess?.txHash &&
      !isZeroAddress(step.action.fromToken.address) &&
      (shouldBatchTransactions || !isMultisigWalletClient)

    if (checkForAllowance) {
      const data = await checkAllowance(
        fromChain,
        step,
        this.walletClient,
        this.statusManager,
        this.executionOptions,
        this.allowUserInteraction,
        shouldBatchTransactions
      )

      if (data) {
        // allowance doesn't need value
        const baseTransaction: MultisigTransaction = {
          to: step.action.fromToken.address,
          data,
        }

        multisigBatchTransactions.push(baseTransaction)
      }
    }

    // STEP 2: Get transaction
    let process = this.statusManager.findOrCreateProcess(
      step,
      currentProcessType
    )

    if (process.status !== 'DONE') {
      const multisigProcess = step.execution.process.find(
        (p) => !!p.multisigTxHash
      )

      try {
        if (isMultisigWalletClient && multisigProcess) {
          const multisigTxHash = multisigProcess.multisigTxHash as Hash
          if (!multisigTxHash) {
            throw new ValidationError(
              'Multisig internal transaction hash is undefined.'
            )
          }
          await updateMultisigRouteProcess(
            multisigTxHash,
            step,
            process.type,
            fromChain,
            this.statusManager,
            this.multisig
          )
        }

        let txHash: Hash
        if (process.txHash) {
          // Make sure that the chain is still correct
          const updatedWalletClient = await this.checkWalletClient(
            step,
            process
          )
          if (!updatedWalletClient) {
            return step
          }

          // Wait for exiting transaction
          txHash = process.txHash as Hash
        } else {
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'STARTED'
          )

          // Check balance
          await checkBalance(this.walletClient.account!.address, step)

          // Create new transaction
          if (!step.transactionRequest) {
            const { execution, ...stepBase } = step
            const updatedStep = await getStepTransaction(stepBase)
            const comparedStep = await stepComparison(
              this.statusManager,
              step,
              updatedStep,
              this.allowUserInteraction,
              this.executionOptions
            )
            step = {
              ...comparedStep,
              execution: step.execution,
            }
          }

          if (!step.transactionRequest) {
            throw new TransactionError(
              LiFiErrorCode.TransactionUnprepared,
              'Unable to prepare transaction.'
            )
          }

          // STEP 3: Send the transaction
          // Make sure that the chain is still correct
          const updatedWalletClient = await this.checkWalletClient(
            step,
            process
          )
          if (!updatedWalletClient) {
            return step
          }

          process = this.statusManager.updateProcess(
            step,
            process.type,
            'ACTION_REQUIRED'
          )

          if (!this.allowUserInteraction) {
            return step
          }

          let transactionRequest: TransactionParameters = {
            to: step.transactionRequest.to,
            from: step.transactionRequest.from,
            data: step.transactionRequest.data,
            value: step.transactionRequest.value
              ? BigInt(step.transactionRequest.value)
              : undefined,
            gas: step.transactionRequest.gasLimit
              ? BigInt(step.transactionRequest.gasLimit)
              : undefined,
            // gasPrice: step.transactionRequest.gasPrice
            //   ? BigInt(step.transactionRequest.gasPrice as string)
            //   : undefined,
            // maxFeePerGas: step.transactionRequest.maxFeePerGas
            //   ? BigInt(step.transactionRequest.maxFeePerGas as string)
            //   : undefined,
            maxPriorityFeePerGas:
              this.walletClient.account?.type === 'local'
                ? await getMaxPriorityFeePerGas(
                    this.walletClient.extend(publicActions) as PublicClient
                  )
                : step.transactionRequest.maxPriorityFeePerGas
                  ? BigInt(step.transactionRequest.maxPriorityFeePerGas)
                  : undefined,
          }

          if (this.executionOptions?.updateTransactionRequestHook) {
            const customizedTransactionRequest: TransactionParameters =
              await this.executionOptions.updateTransactionRequestHook({
                requestType: 'transaction',
                ...transactionRequest,
              })

            transactionRequest = {
              ...transactionRequest,
              ...customizedTransactionRequest,
            }
          }

          if (shouldBatchTransactions && this.multisig?.sendBatchTransaction) {
            if (transactionRequest.to && transactionRequest.data) {
              const populatedTransaction: MultisigTransaction = {
                value: transactionRequest.value,
                to: transactionRequest.to,
                data: transactionRequest.data,
              }
              multisigBatchTransactions.push(populatedTransaction)

              txHash = await this.multisig?.sendBatchTransaction(
                multisigBatchTransactions
              )
            } else {
              throw new TransactionError(
                LiFiErrorCode.TransactionUnprepared,
                'Unable to prepare transaction.'
              )
            }
          } else {
            txHash = await this.walletClient.sendTransaction({
              to: transactionRequest.to,
              account: this.walletClient.account!,
              data: transactionRequest.data,
              value: transactionRequest.value,
              gas: transactionRequest.gas,
              gasPrice: transactionRequest.gasPrice,
              maxFeePerGas: transactionRequest.maxFeePerGas,
              maxPriorityFeePerGas: transactionRequest.maxPriorityFeePerGas,
              chain: null,
            } as SendTransactionParameters)
          }

          // STEP 4: Wait for the transaction
          if (isMultisigWalletClient) {
            process = this.statusManager.updateProcess(
              step,
              process.type,
              'ACTION_REQUIRED',
              {
                multisigTxHash: txHash,
              }
            )
          } else {
            process = this.statusManager.updateProcess(
              step,
              process.type,
              'PENDING',
              {
                txHash: txHash,
                txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${txHash}`,
              }
            )
          }
        }

        const transactionReceipt = await waitForTransactionReceipt({
          walletClient: this.walletClient,
          chainId: fromChain.id,
          txHash,
          onReplaced: (response) => {
            this.statusManager.updateProcess(step, process.type, 'PENDING', {
              txHash: response.transaction.hash,
              txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${response.transaction.hash}`,
            })
          },
        })

        // if it's multisig wallet client and the process is in ACTION_REQUIRED
        // then signatures are still needed
        if (isMultisigWalletClient && process.status === 'ACTION_REQUIRED') {
          await updateMultisigRouteProcess(
            transactionReceipt?.transactionHash || txHash,
            step,
            process.type,
            fromChain,
            this.statusManager,
            this.multisig
          )
        }

        // Update pending process if the transaction hash from the receipt is different.
        // This might happen if the transaction was replaced.
        if (
          !isMultisigWalletClient &&
          transactionReceipt?.transactionHash &&
          transactionReceipt.transactionHash !== txHash
        ) {
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'PENDING',
            {
              txHash: transactionReceipt.transactionHash,
              txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${transactionReceipt.transactionHash}`,
            }
          )
        }

        if (isBridgeExecution) {
          process = this.statusManager.updateProcess(step, process.type, 'DONE')
        }
      } catch (e: any) {
        const error = await parseEVMErrors(e, step, process)
        process = this.statusManager.updateProcess(
          step,
          process.type,
          'FAILED',
          {
            error: {
              message: error.cause.message,
              code: error.code,
            },
          }
        )
        this.statusManager.updateExecution(step, 'FAILED')

        throw error
      }
    }

    // STEP 5: Wait for the receiving chain
    const processTxHash = process.txHash
    if (isBridgeExecution) {
      process = this.statusManager.findOrCreateProcess(
        step,
        'RECEIVING_CHAIN',
        'PENDING'
      )
    }
    let statusResponse: FullStatusData

    try {
      if (!processTxHash) {
        throw new Error('Transaction hash is undefined.')
      }
      statusResponse = (await waitForReceivingTransaction(
        processTxHash,
        this.statusManager,
        process.type,
        step
      )) as FullStatusData

      const statusReceiving =
        statusResponse.receiving as ExtendedTransactionInfo

      process = this.statusManager.updateProcess(step, process.type, 'DONE', {
        substatus: statusResponse.substatus,
        substatusMessage:
          statusResponse.substatusMessage ||
          getSubstatusMessage(statusResponse.status, statusResponse.substatus),
        txHash: statusReceiving?.txHash,
        txLink: `${toChain.metamask.blockExplorerUrls[0]}tx/${statusReceiving?.txHash}`,
      })

      this.statusManager.updateExecution(step, 'DONE', {
        fromAmount: statusResponse.sending.amount,
        toAmount: statusReceiving?.amount,
        toToken: statusReceiving?.token,
        gasCosts: [
          {
            amount: statusResponse.sending.gasAmount,
            amountUSD: statusResponse.sending.gasAmountUSD,
            token: statusResponse.sending.gasToken,
            estimate: statusResponse.sending.gasUsed,
            limit: statusResponse.sending.gasUsed,
            price: statusResponse.sending.gasPrice,
            type: 'SEND',
          },
        ],
      })
    } catch (e: unknown) {
      const htmlMessage = await getTransactionFailedMessage(
        step,
        process.txLink
      )

      process = this.statusManager.updateProcess(step, process.type, 'FAILED', {
        error: {
          code: LiFiErrorCode.TransactionFailed,
          message: 'Failed while waiting for receiving chain.',
          htmlMessage,
        },
      })
      this.statusManager.updateExecution(step, 'FAILED')
      throw await parseEVMErrors(e as Error, step, process)
    }

    // DONE
    return step
  }
}
