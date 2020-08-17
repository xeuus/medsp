const express = require('express');
const {Server} = require('http');
const baseURL = '';
const {createWorker} = require('mediasoup');
const codecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters:
            {
                'x-google-start-bitrate': 1000
            }
    },
];

async function initialize() {
    const worker = await createWorker({
        rtcMinPort: 20000,
        rtcMaxPort: 29999
    });
    worker.on('died', () => {
        console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
        setTimeout(() => process.exit(1), 2000);
    });
    const router = await worker.createRouter({mediaCodecs: codecs});
    return {worker, router};
}

(async () => {
    const {worker, router} = await initialize();

    async function createWebRtcTransport() {
        const maxIncomingBitrate = 1500000;
        const initialAvailableOutgoingBitrate = 1000000;

        const transport = await router.createWebRtcTransport({
            listenIps: ['0.0.0.0'],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate,
        });
        if (maxIncomingBitrate) {
            try {
                await transport.setMaxIncomingBitrate(maxIncomingBitrate);
            } catch (error) {
            }
        }
        return {
            transport,
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            },
        };
    }

    let consumer;
    let consumerTransport;
    let producer;
    let producerTransport;

    async function createConsumer(producer, rtpCapabilities) {
        if (!router.canConsume(
            {
                producerId: producer.id,
                rtpCapabilities,
            })
        ) {
            console.error('can not consume');
            return;
        }
        try {
            consumer = await consumerTransport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: producer.kind === 'video',
            });
        } catch (error) {
            console.error('consume failed', error);
            return;
        }

        if (consumer.type === 'simulcast') {
            await consumer.setPreferredLayers({spatialLayer: 2, temporalLayer: 2});
        }

        return {
            producerId: producer.id,
            id: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused
        };
    }


    const app = express();
    const server = new Server(app);
    app.use(express.urlencoded({extended: false}));
    app.use(express.json());

    const io = require('socket.io')(server, {
        path: baseURL + '/signal',
    });

    io.on('connection', (socket) => {
        socket.on('getSocketID', (data, callback) => {
            callback(socket.id);
        });

        socket.on('disconnect', () => {
            console.log('client disconnected');
        });

        socket.on('connect_error', (err) => {
            console.error('client connection error', err);
        });

        socket.on('getRouterRtpCapabilities', (data, callback) => {
            callback(router.rtpCapabilities);
        });


        socket.on('createConsumerTransport', async (data, callback) => {
            try {
                const {transport, params} = await createWebRtcTransport();
                consumerTransport = transport;
                callback(params);
            } catch (err) {
                console.error(err);
                callback({error: err.message});
            }
        });

        socket.on('connectProducerTransport', async (data, callback) => {
            await producerTransport.connect({dtlsParameters: data.dtlsParameters});
            callback();
        });

        socket.on('connectConsumerTransport', async (data, callback) => {
            await consumerTransport.connect({dtlsParameters: data.dtlsParameters});
            callback();
        });

        socket.on('produce', async (data, callback) => {
            const {kind, rtpParameters} = data;
            producer = await producerTransport.produce({
                kind, rtpParameters,
            });
            callback({id: producer.id});
            socket.broadcast.emit('newProducer');
        });

        socket.on('consume', async (data, callback) => {
            callback(await createConsumer(producer, data.rtpCapabilities));
        });

        socket.on('resume', async (data, callback) => {
            await consumer.resume();
            callback();
        });

    });

    const conn = server.listen(5000, () => {
        console.log('Listening on ' + conn.address().port)
    });
})();
