const {Wallet, ethers} = require ('ethers')
const {FlashbotsBundleProvider, FlashbotsBundleResolution}= require('@flashbots/ethers-provider-bundle')
const { UniswapAbi, UniswapBytecode, UniswapFactoryAbi, UniswapFactoryBytecode, pairAbi, pairBytecode, erc20Abi, erc20Bytecode, Uniswapv3Abi } = require ('./abi.js')
const {dotenv}= require('dotenv')
const { SigningKey } = require('ethers/lib/utils.js')
require('dotenv').config();

const wethAddress = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6'
const uniswapAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const uniswapFactoryAddress= '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
const uinversalRouteraddress = '0x4648a43B2C14Da09FdF82B161150d3F634f40491'
  
const flashbotUrl = 'https://relay-goerli.flashbots.net'
const httpProviderUrl = process.env.httpsProviderUrl
const wsProviderUrl = process.env.wsProviderUrl
const privateKey = process.env.PRIVATE_KEY

const provider = new ethers.providers.JsonRpcProvider(httpProviderUrl)
const wsProvider = new ethers.providers.WebSocketProvider(wsProviderUrl)

const signinWallet = new Wallet(privateKey).connect(provider)
const uniswapV3Interface = new ethers.utils.Interface(Uniswapv3Abi)
const FactoryUniswapFactory = new ethers.ContractFactory(UniswapFactoryAbi,UniswapFactoryBytecode,signinWallet).attach(uniswapFactoryAddress)
const erc20Factory = new ethers.ContractFactory(erc20Abi,erc20Bytecode, signinWallet)
const pairFactory = new ethers.ContractFactory(pairAbi,pairBytecode,signinWallet)
const uniswap =  new ethers.ContractFactory(UniswapAbi,UniswapBytecode,signinWallet).attach(uniswapAddress)

const bribeToMiners = ethers.utils.parseUnits('20','gwei')
const buyAmount = ethers.utils.parseEther('0.1','ether')
const chainId = 5
let flashbotsProvider = null

// 1. Create the start function to listen to tx

const start = async ()=>{
    flashbotsProvider = await FlashbotsBundleProvider.create(provider, signinWallet, flashbotUrl)
    console.log('Listening on tx for the chain id', chainId)
    wsProvider.on('pending',tx=>{
        console.log('tx',tx)
        processTransaction(tx)
    })
    
}

// 2. Decode uniswap Universal Router transaction
const decodeUniversalRouterSwap = input=>{
    const abiCoder = new ethers.utils.AbiCoder()
    const decodedParameters = abiCoder.decode(['address','uint256','uint256','bytes','bool'], input)
    const breakdown= input.substring(2).match(/.{1,64}/g)

    let path = []
    let hasTwoPath= true
    if(breakdown.length>=9){
        const pathOne = '0x'+ breakdown[breakdown.length-2].substring(24)
        const pathTwo = '0x'+ breakdown[breakdown.length-1].substring(24)
        path = [pathOne,pathTwo]
    }else{
        hasTwoPath= false
    }
    return {
        recipient: parseInt(decodedParameters[0,16]),
        amountIn: decodedParameters[1],
        minAmountOut: decodedParameters[2],
        path,
        hasTwoPath,
    }
}

// 3. Setup initial checks

const intialChecks = async tx=>{
    let transaction = null
    let decoded = null
    let decodedSwap = null
    try{
        transaction = await provider.getTransaction(tx)
    }catch (e) {
        return false
    }
    if (
        !transaction
        || !transaction.to
    )return false

    if (Number(transaction.value)==0) return false
    if (transaction.to.toLowerCase()!=uinversalRouteraddress.toLowerCase){
        return false
    }
    try {
        decoded = uniswapV3Interface.parseTransaction(transaction)
    }catch (e){
        return false
    }
    // console.log('decoded', decoded)
    if(!decoded.args.commands.includes('08')) return false
    let swapPositionInCommands = decoded.args.commands.substring(2).indexOf('08')/2
    let inputPosition = decoded.args.inputs(swapPositionInCommands)
    decodedSwap = decodeUniversalRouterSwap(inputPosition)
    if (!decodedSwap.hasTwoPath) return false
    if (decodedSwap.recipient==2) return false
    if(decodedSwap.path[0].toLowerCase()!= wethAddress.toLowerCase()) return false

    return{
        transaction,
        amountIn: transaction.value,
        minAmountOut: decodedSwap.minAmountOut,
        tokenToCapture: decodedSwap.path[1],

    }
}


// 4. Process Transaction

const processTransaction = async tx=>{
    const checksPassed= await intialChecks(tx)
    if (!checksPassed) return false
    const {
        transaction,
        amountIn, // Victim's Ether
        minAmountOut,
        tokenToCapture,
    }= checksPassed

    console.log('Checks passed', tx)

    // 5. Get and sort the pairs
    const pairAddress = await FactoryUniswapFactory.getPair(wethAddress, tokenToCapture)
    const pair = pairFactory.attach(pairAddress)

    let reserves = null
    try{
        reserves = await pair.getReserves()
    }catch (e){
        return false
    }

    let a 
    let b
    if (wethAddress<tokenToCapture){
        a = reserves._reserve0
        b = reserves._reserve1
    }
    else{
        a = reserves._reserve1
        b = reserves._reserve0
    }

    // 6. Get fee costs for simplicity we'll add the user's gas fee
    const maxGasFee = transaction.maxFeePerGas ? transaction.maxFeePerGas.add(bribeToMiners): bribeToMiners
    const priorityFee = transaction.maxPriorityFeePerGas.add(bribeToMiners)

    // 7. Buy using your amount in and calculate amount out
    let firstAmountOut = await uniswap.getAmountOut(buyAmount,a,b)
    const updateReservesA = a.add(buyAmount)
    const updateReservesB = b.add(firstAmountOut)
    let secondBuyAmount= await uniswap.getAmountOut(amountIn,updateReservesA,updateReservesB)
    
    console.log('secondAmount', secondBuyAmount.toString())
    console.log('minimumAmountOut', minAmountOut.toString())
    if(secondBuyAmount.lt(minAmountOut)) return console.log('Victim would get less amount than minimum')
    const updateReservesA2 = updateReservesA.add(amountIn)
    const updateReservesB2 = updateReservesB.add(secondBuyAmount)
    // Potential ETH we get at the end
    let thirdAmountOut = await uniswap.getAmountOut(firstAmountOut, updateReservesB2,updateReservesA2)


    // 8. Prepare first Transaction
    const deadline= Math.floor(Date.now/1000) +60*60 // 1 hr from now
    let firstTransaction = {
        signer: signinWallet,
        transaction: await uniswap.populateTransaction.swapExactETHforTokens(
            firstAmountOut, 
            [
                wethAddress,
                tokenToCapture
            ],
            signinWallet.address,
            deadline,
            {
                value: buyAmount,
                type:2,
                maxFeePerGas:maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 3000000,
            }

        )
    }

    firstTransaction.transaction={
        ...firstTransaction.transaction,
        chainId
    }

    // 9. Prepare Second Transation
    const victimsTransactionWithChainID= {
        chainId,
        ...transaction,
    }
    const signedMiddleTransaction = {
        signedTransaction: ethers.utils.serializeTransaction(victimsTransactionWithChainID,{
            r: victimsTransactionWithChainID.r,
            s:victimsTransactionWithChainID.s,
            v:victimsTransactionWithChainID.v,
        })
    }

    // 10. Prepare third transaction for the approval
    const erc20 = erc20Factory.attach(tokenToCapture)
    let thirdTransaction = {
        signer: signinWallet,
        transaction: await erc20.populateTransaction.approve(
            uniswapAddress,
            firstAmountOut,
            {
                value: '0',
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 3000000,
            },
        ),
    }

    thirdTransaction.transaction={
        ...thirdTransaction.transaction,
        chainId,
    }

    // 11. Prepare the last transaction to get the final ether
    let fourthTransaction = {
        signer: signinWallet,
        transaction: await uniswap.populateTransaction.swapExactTokenforEth(
            firstAmountOut,
            thirdAmountOut,
            [
                tokenToCapture,
                wethAddress
            ],
            signinWallet.address,
            deadline,
            {
                value: '0',
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 3000000,
            },

        )
    }

    fourthTransaction.transaction= {
        ...fourthTransaction.transaction,
        chainId,
    }

    const transactionArray ={
        firstTransaction,
        signedMiddleTransaction,
        thirdTransaction,
        fourthTransaction,

    }

    const signedTransaction = await flashbotsProvider.signBundle(transactionArray)
    const blockNumber = await provider.getBlockNumber()
    console.log('Simulating......')
    const simulation = await flashbotsProvider.simulate(
        signedTransaction,
        blockNumber+1,
    )
    if(simulation.firstRevert){
        return console.log('Simulation error', simulation.firstRevert)
    }else {
        console.log('Simulation Success', simulation)
    }

    // 12. Send Transaction with Flashbots

    let bundleSubmission 
    flashbotsProvider.sendRawBudle(
        signedTransaction,
        blockNumber +1,
    ).then(_bundleSubmission =>{
        bundleSubmission = _bundleSubmission
        console.log('Bundle submitted', bundleSubmission.bundleHash)
        return bundleSubmission.wait()
    }).then(async waitResponse =>{
        console.log('Wait Response', FlashbotsBundleResolution[waitResponse])
        if (waitResponse ==FlashbotsBundleResolution.BundleIncluded){
            console.log('-----------------------------')
            console.log('-----------------------------')
            console.log('------Bundle Included--------')
            console.log('-----------------------------')
            console.log('-----------------------------')
        }else if (waitResponse==FlashbotsBundleResolution.AccountNonceTooHigh){
            console.log('The transaction has been confirmed already')
        }else{
            console.log('Bunle hash', bundleSubmission.bundleHash)
            try{
                console.log({
                    bundleStats: await flashbotsProvider.getBundleStats(
                        bundleSubmission.bundleHash,
                        blockNumber +1 ,  
                    ),
                    userStats: await flashbotsProvider.getUserStats(),
                })
            }catch(e){
                return false
            }
        }
    })

}   

start()



