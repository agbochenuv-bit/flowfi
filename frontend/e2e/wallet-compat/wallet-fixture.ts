import { connectWallet } from "@/lib/wallet";
import { cancelStream } from "@/lib/soroban";

Object.assign(window, { connectWallet, cancelStream });
