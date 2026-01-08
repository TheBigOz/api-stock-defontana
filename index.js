const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN
        console.log('1. Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
        // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 

        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('2. Login OK. Abriendo ERP...');

        // 2. ABRIR PESTAÑA ERP
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        await erpButton.click();
        await new Promise(r => setTimeout(r, 5000)); // Espera creación pestaña

        // 3. RECUPERAR PESTAÑA (Refresh)
        const pages = await browser.pages();
        const erpPage = pages[pages.length - 1]; 

        if (!erpPage) throw new Error("No se pudo detectar la pestaña del ERP");

        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('3. Pestaña capturada. ESPERANDO 15 SEGUNDOS...');
        await new Promise(r => setTimeout(r, 15000));

        // 4. NAVEGACIÓN
        console.log('4. Buscando menú Inventario...');
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        try {
            await erpPage.waitForXPath(xpathInventario, { visible: true, timeout: 5000 });
            const [btnInv] = await erpPage.$x(xpathInventario);
            await erpPage.evaluate(el => el.click(), btnInv);
        } catch(e) { console.log('   (Inventario quizás ya estaba abierto)'); }

        await new Promise(r => setTimeout(r, 1000));

        console.log('5. Clickeando Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArt] = await erpPage.$x(xpathArticulos);
        await erpPage.evaluate(el => el.click(), btnArt);

        console.log('6. Esperando carga de módulo (10 seg)...');
        await new Promise(r => setTimeout(r, 10000)); 

        // 5. BÚSQUEDA DEL INPUT (MODO SABUESO)
        console.log('7. Escaneando TODOS los frames buscando el input...');
        
        let targetFrame = null;
        let foundSelector = null;
        const selectorPrincipal = 'input[formcontrolname="searchInputText"]';
        
        const allFrames = erpPage.frames();
        console.log(`   > Se encontraron ${allFrames.length} marcos/frames.`);

        for (const frame of allFrames) {
            const existe = await frame.$(selectorPrincipal);
            if (existe) {
                console.log(`   > ¡EUREKA! Input encontrado en frame: ${frame.url()}`);
                targetFrame = frame;
                foundSelector = selectorPrincipal;
                break;
            }
        }

        if (!targetFrame) {
            console.log('   > Selector exacto falló. Buscando por placeholder...');
            for (const frame of allFrames) {
                const existe = await frame.$('input[placeholder*="escripción"]'); 
                if (existe) {
                    console.log(`   > Encontrado por placeholder en frame: ${frame.url()}`);
                    targetFrame = frame;
                    foundSelector = 'input[placeholder*="escripción"]';
                    break;
                }
            }
        }

        if (!targetFrame) {
            throw new Error(`No se encontró el input en ninguno de los ${allFrames.length} frames.`);
        }

        // ACCIÓN: Escribir SKU
        console.log(`8. Escribiendo SKU en el frame correcto...`);
        
        // 1. Hacemos click para asegurar el FOCO dentro del iframe
        await targetFrame.click(foundSelector); 
        await new Promise(r => setTimeout(r, 500));

        // 2. Borramos y escribimos (Usando el frame)
        await targetFrame.evaluate((sel) => { document.querySelector(sel).value = ''; }, foundSelector);
        await targetFrame.type(foundSelector, skuLimpio);
        
        // 3. ENTER (CORREGIDO: Usamos erpPage.keyboard, no targetFrame.keyboard)
        // El foco ya está en el input, así que el teclado global funcionará.
        await erpPage.keyboard.press('Enter');

        // 6. RESULTADOS
        console.log('9. Esperando resultados...');
        try {
            // Buscamos la tabla DENTRO del mismo frame donde estaba el input
            await targetFrame.waitForSelector('.mat-column-id', { timeout: 15000 });
        } catch (e) {
            console.log('...Tabla lenta o vacía...');
        }

        const resultado = await targetFrame.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
