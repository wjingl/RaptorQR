export type TransferProtocol = 'raptorqr' | 'cimbar';
export type TransferDirection = 'send' | 'receive';

export interface ProtocolDescriptor {
  id: TransferProtocol;
  name: string;
  shortName: string;
  description: string;
  available: boolean;
  availabilityNote?: string;
}

export const PROTOCOLS: ProtocolDescriptor[] = [
  {
    id: 'raptorqr',
    name: 'RaptorQR',
    shortName: '标准 QR',
    description: '适合大多数设备，支持文本、文件、GIF 和摄像头传输。',
    available: true,
  },
  {
    id: 'cimbar',
    name: 'Cimbar',
    shortName: '彩色条码',
    description: '高吞吐彩色条码传输，支持独立摄像头接收。',
    available: true,
    availabilityNote: '彩色条码模式，适合高吞吐传输。',
  },
];

export function getProtocol(id: TransferProtocol): ProtocolDescriptor {
  return PROTOCOLS.find((protocol) => protocol.id === id) ?? PROTOCOLS[0];
}
